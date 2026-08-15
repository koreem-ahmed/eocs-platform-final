const DEFAULT_BLIND_MINUTES = 30;

export const getCompetitionStatus = (
    now = new Date(),
    startValue = process.env.COMPETITION_START_TIME,
    endValue = process.env.COMPETITION_END_TIME,
    blindValue = process.env.SCOREBOARD_BLIND_MINUTES ?? DEFAULT_BLIND_MINUTES
) => {
    const startTime = new Date(startValue);
    const endTime = new Date(endValue);
    const blindMinutes = Number(blindValue);
    const blindDurationMs = blindMinutes * 60 * 1000;
    const invalidWindow = Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime()) || startTime >= endTime;
    const invalidBlindPeriod = !Number.isInteger(blindMinutes) || blindMinutes < 0 || (!invalidWindow && blindDurationMs > endTime - startTime);
    if (invalidWindow || invalidBlindPeriod) {
        return {
            status: 'invalid', timeUntil: null, startTime, endTime, blindMinutes,
            scoreboardFreezeTime: null, isScoreboardFrozen: false
        };
    }
    const scoreboardFreezeTime = new Date(endTime.getTime() - blindDurationMs);
    const isScoreboardFrozen = blindMinutes > 0 && now >= scoreboardFreezeTime && now < endTime;
    const common = { startTime, endTime, blindMinutes, scoreboardFreezeTime, isScoreboardFrozen };
    if (now < startTime) return { status: 'before', timeUntil: startTime, ...common };
    if (now < endTime) return { status: 'active', timeUntil: endTime, ...common };
    return { status: 'ended', timeUntil: null, ...common, isScoreboardFrozen: false };
};
