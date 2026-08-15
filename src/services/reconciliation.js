import { DEFAULT_PENALTY_MINUTES, DEFAULT_SUBTASK_POINTS, resolveSubtaskPoints } from '../config/scoring.js';

const emptyExpected = () => ({ totalScore: 0, totalPenalty: 0, totalTrials: 0, sections: new Map() });

const entries = value => value instanceof Map ? [...value.entries()] : Object.entries(value || {});

const buildPointLookup = problems => new Map(problems.flatMap(problem =>
    entries(problem.sections).map(([sectionId, sectionDefinition]) => [
        `${problem.id}:${sectionId}`,
        resolveSubtaskPoints(sectionDefinition?.maxPoints)
    ])
));

export const calculateExpectedScores = (submissions, wrongPenaltyMinutes = DEFAULT_PENALTY_MINUTES, problems = []) => {
    const expectedByTeam = new Map();
    const pointsBySection = buildPointLookup(problems);

    for (const submission of submissions) {
        if (!expectedByTeam.has(submission.teamId)) expectedByTeam.set(submission.teamId, emptyExpected());
        const team = expectedByTeam.get(submission.teamId);
        const key = `${submission.problemId}:${submission.section}`;
        if (!team.sections.has(key)) {
            team.sections.set(key, {
                problemId: String(submission.problemId),
                sectionId: String(submission.section),
                status: 'unsolved',
                score: 0,
                maxPoints: pointsBySection.get(key) ?? DEFAULT_SUBTASK_POINTS,
                penalty: 0,
                trials: 0
            });
        }
        const section = team.sections.get(key);
        section.trials += 1;
        team.totalTrials += 1;

        if (submission.status === 'wrong') {
            section.penalty += wrongPenaltyMinutes;
            team.totalPenalty += wrongPenaltyMinutes;
            if (section.status !== 'correct') section.status = 'wrong';
        } else if (submission.status === 'correct' && section.status !== 'correct') {
            section.status = 'correct';
            section.score = section.maxPoints;
            team.totalScore += section.maxPoints;
        }
    }
    return expectedByTeam;
};

const actualSection = (score, problemId, sectionId) => {
    const problem = score?.problems?.get?.(String(problemId)) || score?.problems?.[String(problemId)];
    return problem?.sections?.get?.(String(sectionId)) || problem?.sections?.[String(sectionId)];
};

export const reconcileScores = (submissions, scores, wrongPenaltyMinutes = DEFAULT_PENALTY_MINUTES, problems = []) => {
    const expectedByTeam = calculateExpectedScores(submissions, wrongPenaltyMinutes, problems);
    const actualByTeam = new Map(scores.map(score => [score.teamId, score]));
    const mismatches = [];

    for (const [teamId, expected] of expectedByTeam) {
        const actual = actualByTeam.get(teamId);
        if (!actual) {
            mismatches.push({ teamId, field: 'scoreDocument', expected: 'present', actual: 'missing' });
            continue;
        }
        for (const field of ['totalScore', 'totalPenalty', 'totalTrials']) {
            if (Number(actual[field] || 0) !== expected[field]) {
                mismatches.push({ teamId, field, expected: expected[field], actual: Number(actual[field] || 0) });
            }
        }
        for (const section of expected.sections.values()) {
            const actualValue = actualSection(actual, section.problemId, section.sectionId);
            if (!actualValue) {
                mismatches.push({
                    teamId,
                    field: `${section.problemId}.${section.sectionId}`,
                    expected: section,
                    actual: 'missing'
                });
                continue;
            }
            for (const field of ['status', 'score', 'penalty', 'trials']) {
                if ((actualValue[field] ?? 0) !== section[field]) {
                    mismatches.push({
                        teamId,
                        field: `${section.problemId}.${section.sectionId}.${field}`,
                        expected: section[field],
                        actual: actualValue[field] ?? 0
                    });
                }
            }
        }
    }

    const pendingCount = submissions.filter(submission => submission.status === 'pending').length;
    const reviewedCount = submissions.filter(submission => ['correct', 'wrong'].includes(submission.status)).length;
    const acceptedCount = submissions.length;
    return {
        ok: mismatches.length === 0,
        acceptedCount,
        pendingCount,
        reviewedCount,
        teamCount: expectedByTeam.size,
        mismatches
    };
};
