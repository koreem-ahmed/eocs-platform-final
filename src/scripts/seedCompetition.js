import dns from 'node:dns';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import problems2026 from '../data/problems2026.js';
import Problem from '../models/Problem.js';
import Score from '../models/Score.js';
import Submission from '../models/Submission.js';
import Team from '../models/Team.js';
import { buildInitialProblemScores } from '../services/scoreFactory.js';

dotenv.config();

const REQUIRED_CONFIRMATION = 'true';

const getSectionValues = (sections) => sections instanceof Map
    ? Array.from(sections.values())
    : Object.values(sections || {});

const validateProblemSet = () => {
    const ids = problems2026.map((problem) => problem.id);
    const subtaskCount = problems2026.reduce(
        (total, problem) => total + getSectionValues(problem.sections).length,
        0
    );
    const totalPoints = problems2026.reduce(
        (total, problem) => total + getSectionValues(problem.sections)
            .reduce((sum, subtask) => sum + Number(subtask.maxPoints || 0), 0),
        0
    );

    if (problems2026.length !== 20 || new Set(ids).size !== 20
        || Math.min(...ids) !== 1 || Math.max(...ids) !== 20
        || subtaskCount !== 67 || totalPoints !== 400) {
        throw new Error(`Invalid 2026 problem set: ${problems2026.length} problems, ${subtaskCount} subtasks, ${totalPoints} points`);
    }

    return { problems: problems2026.length, subtasks: subtaskCount, totalPoints };
};

const archiveCollection = async (database, sourceName, archiveName) => {
    const sourceExists = await database.listCollections({ name: sourceName }, { nameOnly: true }).hasNext();
    if (!sourceExists) {
        await database.createCollection(archiveName);
        return 0;
    }

    const sourceCount = await database.collection(sourceName).countDocuments({});
    await database.collection(sourceName).aggregate([
        { $match: {} },
        { $out: archiveName }
    ], { allowDiskUse: true }).toArray();

    const archiveCount = await database.collection(archiveName).countDocuments({});
    if (archiveCount !== sourceCount) {
        throw new Error(`Archive verification failed for ${sourceName}: expected ${sourceCount}, copied ${archiveCount}`);
    }
    return archiveCount;
};

const verifyFreshScores = async () => {
    const scores = await Score.find({}).select('totalScore totalPenalty totalTrials problems').lean();
    for (const score of scores) {
        const problems = score.problems instanceof Map ? score.problems : new Map(Object.entries(score.problems || {}));
        let subtaskCount = 0;
        let totalPoints = 0;
        for (const problem of problems.values()) {
            const sections = problem.sections instanceof Map
                ? problem.sections
                : new Map(Object.entries(problem.sections || {}));
            subtaskCount += sections.size;
            for (const section of sections.values()) totalPoints += Number(section.maxPoints || 0);
        }
        if (problems.size !== 20 || subtaskCount !== 67 || totalPoints !== 400
            || score.totalScore !== 0 || score.totalPenalty !== 0 || score.totalTrials !== 0) {
            throw new Error('Fresh score verification failed');
        }
    }
    return scores.length;
};

const run = async () => {
    if (process.env.ALLOW_2026_MIGRATION !== REQUIRED_CONFIRMATION) {
        throw new Error('Set ALLOW_2026_MIGRATION=true to run the recoverable 2026 migration');
    }
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');

    const dataset = validateProblemSet();
    const dnsServers = (process.env.MONGODB_DNS_SERVERS || '')
        .split(',')
        .map((server) => server.trim())
        .filter(Boolean);
    if (dnsServers.length > 0) dns.setServers(dnsServers);

    await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 15000),
        maxPoolSize: Number(process.env.MONGODB_MAX_POOL_SIZE || 20),
        minPoolSize: Number(process.env.MONGODB_MIN_POOL_SIZE || 1)
    });

    const database = mongoose.connection.db;
    const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
    const archivePrefix = `archive_2026_${timestamp}`;
    const archives = {};

    for (const sourceName of ['problems', 'scores', 'submissions']) {
        const archiveName = `${archivePrefix}_${sourceName}`;
        archives[sourceName] = {
            collection: archiveName,
            documents: await archiveCollection(database, sourceName, archiveName)
        };
    }

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const teams = await Team.find({}).select('teamId -_id').sort({ teamId: 1 }).session(session).lean();

            await Submission.deleteMany({}, { session });
            await Score.deleteMany({}, { session });
            await Problem.deleteMany({}, { session });
            await Problem.insertMany(problems2026, { session });

            if (teams.length > 0) {
                const scores = teams.map(({ teamId }) => ({
                    teamId,
                    totalScore: 0,
                    totalPenalty: 0,
                    totalTrials: 0,
                    problems: buildInitialProblemScores(problems2026),
                    lastUpdated: new Date()
                }));
                await Score.insertMany(scores, { session });
            }
        });
    } finally {
        await session.endSession();
    }

    const [problemCount, teamCount, submissionCount, scoreCount] = await Promise.all([
        Problem.countDocuments({}),
        Team.countDocuments({}),
        Submission.countDocuments({}),
        verifyFreshScores()
    ]);

    if (problemCount !== dataset.problems || scoreCount !== teamCount || submissionCount !== 0) {
        throw new Error('Post-migration collection verification failed');
    }

    console.log(JSON.stringify({
        migrated: true,
        dataset,
        teamsPreserved: teamCount,
        scoresReset: scoreCount,
        submissionsReset: submissionCount,
        archives
    }));
};

try {
    await run();
} catch (error) {
    console.error(`2026 migration failed: ${error.message}`);
    process.exitCode = 1;
} finally {
    await mongoose.disconnect();
}
