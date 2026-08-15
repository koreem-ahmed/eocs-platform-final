export const isNonEmptyString = (value, maxLength = Infinity) =>
    typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;

export const parseProblemId = (value) => {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 20 ? parsed : null;
};

export const normalizeSection = (value) => {
    if (typeof value !== 'string') return null;
    const section = value.trim();
    return /^(?:[A-E]|10|[1-9])$/.test(section) ? section : null;
};

export const parseBoolean = (value) => value === true || value === 'true' || value === 'on';
