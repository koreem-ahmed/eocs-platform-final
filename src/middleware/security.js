import crypto from 'crypto';
import { rateLimit } from 'express-rate-limit';

const jsonOrRedirect = (req, res, status, message, redirectPath = '/') => {
    const acceptsJson = req.xhr || req.is('application/json') || req.get('accept')?.includes('json');
    if (acceptsJson) return res.status(status).json({ success: false, message });
    return res.status(status).redirect(redirectPath);
};

export const createCsrfProtection = () => (req, res, next) => {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    res.locals.csrfToken = req.session.csrfToken;

    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

    const candidate = req.get('x-csrf-token') || req.body?._csrf;
    const expected = req.session.csrfToken;
    if (typeof candidate !== 'string' || candidate.length !== expected.length) {
        return jsonOrRedirect(req, res, 403, 'Invalid or missing CSRF token', req.path.startsWith('/admin') ? '/admin/login' : '/login');
    }

    const valid = crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
    if (!valid) {
        return jsonOrRedirect(req, res, 403, 'Invalid or missing CSRF token', req.path.startsWith('/admin') ? '/admin/login' : '/login');
    }
    next();
};

const limiter = (windowMs, max, message) => rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, res) => jsonOrRedirect(req, res, 429, message, req.path.startsWith('/admin') ? '/admin/login' : '/login')
});

export const createSecurityLimiters = () => ({
    login: limiter(15 * 60 * 1000, Number(process.env.LOGIN_RATE_LIMIT || 20), 'Too many login attempts. Try again later.'),
    submission: limiter(60 * 1000, Number(process.env.SUBMISSION_RATE_LIMIT || 30), 'Too many submission attempts. Slow down.'),
    clarification: limiter(15 * 60 * 1000, Number(process.env.CLARIFICATION_RATE_LIMIT || 20), 'Too many clarification requests.'),
    admin: limiter(60 * 1000, Number(process.env.ADMIN_RATE_LIMIT || 180), 'Too many admin actions. Slow down.')
});

export const parseAllowedOrigins = () => (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);

export const cspDirectives = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com', 'data:'],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"]
};
