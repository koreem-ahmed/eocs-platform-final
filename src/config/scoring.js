export const DEFAULT_PENALTY_MINUTES = 15;
export const DEFAULT_SUBTASK_POINTS = 20;

export const resolvePenaltyMinutes = value => {
    const parsed = Number(value ?? DEFAULT_PENALTY_MINUTES);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PENALTY_MINUTES;
};

export const resolveSubtaskPoints = value => {
    const parsed = Number(value ?? DEFAULT_SUBTASK_POINTS);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_SUBTASK_POINTS;
};
