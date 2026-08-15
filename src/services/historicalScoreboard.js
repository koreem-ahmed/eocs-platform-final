import { DEFAULT_PENALTY_MINUTES, resolveSubtaskPoints } from '../config/scoring.js';

const entries = value => {
    if (value instanceof Map) return [...value.entries()];
    if (value && typeof value === 'object') return Object.entries(value);
    return [];
};

const eventTime = value => new Date(value).getTime();

const recalculateTeam = team => {
    team.totalScore = 0;
    team.totalPenalty = 0;
    for (const problem of Object.values(team.problems)) {
        let correctCount = 0;
        let wrongCount = 0;
        problem.totalScore = 0;
        problem.totalPenalty = 0;
        for (const section of problem.sections.values()) {
            problem.totalScore += section.score;
            problem.totalPenalty += section.penalty;
            if (section.status === 'correct') correctCount += 1;
            if (section.status === 'wrong') wrongCount += 1;
        }
        if (problem.sections.size > 0 && correctCount === problem.sections.size) problem.status = 'correct';
        else if (problem.sections.size > 0 && wrongCount === problem.sections.size) problem.status = 'wrong';
        else if (correctCount > 0 || wrongCount > 0) problem.status = 'partial';
        else problem.status = 'unsolved';
        team.totalScore += problem.totalScore;
        team.totalPenalty += problem.totalPenalty;
    }
};

export const buildHistoricalScoreboard = ({
    teams,
    problems,
    submissions,
    auditLogs,
    cutoff,
    wrongPenaltyMinutes = DEFAULT_PENALTY_MINUTES
}) => {
    const cutoffTime = eventTime(cutoff);
    if (!Number.isFinite(cutoffTime)) throw new Error('A valid scoreboard cutoff is required');

    const teamStates = new Map(teams.map(team => {
        const problemStates = {};
        for (const problem of problems) {
            problemStates[String(problem.id)] = {
                totalScore: 0,
                totalPenalty: 0,
                status: 'unsolved',
                sections: new Map(entries(problem.sections).map(([sectionId, sectionDefinition]) => [String(sectionId), {
                    status: 'unsolved', score: 0, maxPoints: resolveSubtaskPoints(sectionDefinition?.maxPoints), trials: 0, penalty: 0
                }]))
            };
        }
        return [String(team.teamId).toUpperCase(), {
            teamId: String(team.teamId).toUpperCase(),
            teamName: team.teamName || String(team.teamId).toUpperCase(),
            totalScore: 0,
            totalPenalty: 0,
            problems: problemStates
        }];
    }));

    const events = [];
    for (const submission of submissions) {
        const submittedAt = eventTime(submission.submittedAt);
        if (submittedAt <= cutoffTime) {
            events.push({ type: 'attempt', time: submittedAt, priority: 0, submission });
        }
        const reviewedAt = eventTime(submission.reviewedAt);
        if (submission.reviewStatus === 'reviewed' && ['correct', 'wrong'].includes(submission.status) && reviewedAt <= cutoffTime) {
            events.push({ type: 'review', time: reviewedAt, priority: 1, submission });
        }
    }
    for (const auditLog of auditLogs) {
        const time = eventTime(auditLog.createdAt);
        if (time <= cutoffTime && ['score.section.update', 'score.problem.update'].includes(auditLog.action)) {
            events.push({ type: auditLog.action, time, priority: 2, auditLog });
        }
    }
    events.sort((left, right) => left.time - right.time || left.priority - right.priority);

    const getSection = (teamId, problemId, sectionId) => {
        const team = teamStates.get(String(teamId).toUpperCase());
        const problem = team?.problems[String(problemId)];
        return { team, problem, section: problem?.sections.get(String(sectionId)) };
    };

    for (const event of events) {
        if (event.type === 'attempt') {
            const { section } = getSection(event.submission.teamId, event.submission.problemId, event.submission.section);
            if (section) section.trials += 1;
            continue;
        }
        if (event.type === 'review') {
            const { section } = getSection(event.submission.teamId, event.submission.problemId, event.submission.section);
            if (!section) continue;
            if (event.submission.status === 'correct') {
                section.status = 'correct';
                section.score = section.maxPoints;
            } else if (section.status !== 'correct') {
                section.status = 'wrong';
                section.score = 0;
                section.penalty += wrongPenaltyMinutes;
            }
            continue;
        }

        const metadata = event.auditLog.metadata || {};
        const { team, problem, section } = getSection(metadata.teamId, metadata.problemId, metadata.section);
        if (!team || !problem || !['correct', 'wrong', 'unsolved'].includes(metadata.status)) continue;
        const applyStatus = target => {
            target.status = metadata.status;
            target.score = metadata.status === 'correct' ? target.maxPoints : 0;
        };
        if (event.type === 'score.section.update' && section) applyStatus(section);
        if (event.type === 'score.problem.update') {
            for (const target of problem.sections.values()) applyStatus(target);
        }
    }

    const scoreboard = [...teamStates.values()];
    for (const team of scoreboard) recalculateTeam(team);
    scoreboard.sort((left, right) => right.totalScore - left.totalScore || left.totalPenalty - right.totalPenalty || left.teamId.localeCompare(right.teamId));
    return scoreboard;
};
