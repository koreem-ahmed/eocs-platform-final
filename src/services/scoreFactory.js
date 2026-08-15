import Problem from '../models/Problem.js';
import Score from '../models/Score.js';
import { resolveSubtaskPoints } from '../config/scoring.js';

export const buildInitialProblemScores = (problems) => {
    const problemScores = new Map();
    for (const problem of problems) {
        const sections = new Map();
        for (const [sectionKey, sectionDefinition] of problem.sections.entries()) {
            sections.set(String(sectionKey), {
                status: 'unsolved', score: 0, maxPoints: resolveSubtaskPoints(sectionDefinition.maxPoints),
                trials: 0, firstSolvedTime: null, penalty: 0
            });
        }
        problemScores.set(String(problem.id), { totalScore: 0, status: 'unsolved', sections });
    }
    return problemScores;
};

export const createInitialScore = async (teamId, mongoSession = null) => {
    const query = Problem.find({}).select('id sections').sort({ id: 1 });
    if (mongoSession) query.session(mongoSession);
    const problems = await query;
    const score = new Score({
        teamId, totalScore: 0, totalPenalty: 0, totalTrials: 0,
        problems: buildInitialProblemScores(problems)
    });
    await score.save(mongoSession ? { session: mongoSession } : undefined);
    return score;
};
