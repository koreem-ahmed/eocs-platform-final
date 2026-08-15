import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import dotenv from 'dotenv';
import multer from 'multer';
import session from 'express-session';
import MongoStore from 'connect-mongo';

// Database and Models
import { connectDB, isConnected } from './config/database.js';
import InMemoryStorage from './config/inMemoryStorage.js';
import Team from './models/Team.js';
import Score from './models/Score.js';
import Submission from './models/Submission.js';
import Announcement from './models/Announcement.js';
import ClarificationRequest from './models/ClarificationRequest.js';
import Problem from './models/Problem.js';
import AuditLog from './models/AuditLog.js';
import { getCompetitionStatus } from './services/competition.js';
import { buildHistoricalScoreboard } from './services/historicalScoreboard.js';
import { createInitialScore } from './services/scoreFactory.js';
import { resolvePenaltyMinutes, resolveSubtaskPoints } from './config/scoring.js';
import { createCsrfProtection, createSecurityLimiters, cspDirectives, parseAllowedOrigins } from './middleware/security.js';
import { isNonEmptyString, normalizeSection, parseBoolean, parseProblemId } from './utils/validation.js';
import { renderMarkdown } from './utils/markdown.js';

// Load environment variables
dotenv.config();

const deploymentEnv = process.env.NODE_ENV || 'development';
const isSecureEnvironment = ['production', 'staging'].includes(deploymentEnv);
const configuredSessionSecret = process.env.SESSION_SECRET;
if (isSecureEnvironment && (!configuredSessionSecret || configuredSessionSecret.length < 32)) {
    throw new Error('SESSION_SECRET must contain at least 32 characters in staging and production');
}
const sessionSecret = configuredSessionSecret || crypto.randomBytes(32).toString('hex');

// Initialize storage
let storage = null;

// Connect to MongoDB or fallback to in-memory storage
const initializeStorage = async () => {
    await connectDB();
    
    if (!isConnected) {
        if (isSecureEnvironment) throw new Error('MongoDB is required in staging and production');
        storage = new InMemoryStorage();
        await storage.initializeSampleData();
        console.log('📝 Running in in-memory mode. Data will be lost on restart.');
    } else {
        console.log('📝 Running with MongoDB persistence.');
    }
};

await initializeStorage();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.locals.renderMarkdown = renderMarkdown;
const PORT = process.env.PORT || 3000;
const maxCodeBytes = Number(process.env.MAX_CODE_BYTES || 102400);
const allowedOrigins = parseAllowedOrigins();
const rateLimits = createSecurityLimiters();

if (isSecureEnvironment) app.set('trust proxy', 1);

// Security middleware
app.use(compression());
app.use(helmet({
    contentSecurityPolicy: { directives: cspDirectives },
    crossOriginEmbedderPolicy: false
}));
app.use(cors({ origin: allowedOrigins.length > 0 ? allowedOrigins : false, credentials: true }));

// Body parsing middleware
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '100kb', parameterLimit: 50 }));
app.use(cookieParser());

// Session configuration
const sessionOptions = {
    name: process.env.SESSION_COOKIE_NAME || (deploymentEnv === 'staging' ? 'eocs.staging.sid' : 'eocs.sid'),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
        secure: isSecureEnvironment,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
};
let sessionStore = null;
if (process.env.MONGODB_URI) {
    sessionStore = MongoStore.create({
        mongoUrl: process.env.MONGODB_URI,
        collectionName: process.env.SESSION_COLLECTION || (deploymentEnv === 'staging' ? 'sessions_staging' : 'sessions'),
        touchAfter: 60 * 60
    });
    sessionOptions.store = sessionStore;
}
app.use(session(sessionOptions));
app.use(createCsrfProtection());

// Set up EJS
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// Static files
app.use('/public', express.static(path.join(__dirname, '..', 'public')));

// Configure multer for form data parsing
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fieldSize: maxCodeBytes, fields: 4, parts: 4 }
});

const expectsJson = (req) => req.xhr || req.is('application/json') || req.get('accept')?.includes('json');
const secureCompare = (left, right) => {
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    const leftHash = crypto.createHash('sha256').update(left).digest();
    const rightHash = crypto.createHash('sha256').update(right).digest();
    return crypto.timingSafeEqual(leftHash, rightHash);
};
const resolveAdminIdentity = (username, password) => {
    const candidates = [
        { role: 'administrator', username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD },
        { role: 'tech-support', username: process.env.TECH_SUPPORT_USERNAME, password: process.env.TECH_SUPPORT_PASSWORD }
    ];
    const match = candidates.find(candidate => candidate.username && candidate.password
        && secureCompare(username, candidate.username) && secureCompare(password, candidate.password));
    return match ? { role: match.role, actor: match.username } : null;
};
const destroySession = (req, res, redirectPath = '/') => {
    req.session.destroy(error => {
        if (error) console.error('Session destroy error:', error.message);
        res.clearCookie(sessionOptions.name);
        res.redirect(redirectPath);
    });
};

// Middleware to check if team is authenticated
const requireAuth = async (req, res, next) => {
    try {
        const teamId = req.session.teamId;
        if (!teamId) {
            if (expectsJson(req)) {
                return res.status(401).json({ success: false, message: 'Authentication required. Please log in again.' });
            }
            return res.redirect('/login');
        }

        let team;
        if (isConnected) {
            team = await Team.findOne({ teamId, isActive: true });
        } else {
            team = await storage.findTeam(teamId);
        }

        if (!team || !team.isActive || team.isAccessExpired?.()) {
            req.session.destroy(() => {});
            if (expectsJson(req)) {
                return res.status(401).json({ success: false, message: 'Team not found or inactive. Please log in again.' });
            }
            return res.redirect('/login');
        }

        req.teamId = teamId;
        req.team = team;
        next();
    } catch (error) {
        console.error('Auth middleware error:', error.message);
        if (expectsJson(req)) {
            return res.status(500).json({ success: false, message: 'Authentication error. Please try again.' });
        }
        res.redirect('/login');
    }
};

// Middleware to check if admin is authenticated
const requireAdmin = (req, res, next) => {
    const isAdmin = req.session.isAdmin;
    if (!isAdmin) {
        if (expectsJson(req)) {
            const status = req.session.teamId ? 403 : 401;
            return res.status(status).json({ success: false, message: 'Administrator authentication required' });
        }
        return res.redirect('/admin/login');
    }
    req.adminRole = req.session.adminRole || 'administrator';
    req.adminActor = req.session.adminActor || 'admin';
    next();
};

// Routes
app.get('/health/live', (req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.floor(process.uptime()), environment: deploymentEnv });
});

app.get('/health/ready', async (req, res) => {
    const databaseReady = mongoose.connection.readyState === 1;
    let sessionStoreReady = !isSecureEnvironment && !sessionStore;
    if (sessionStore) {
        try {
            await sessionStore.collectionP;
            sessionStoreReady = true;
        } catch {
            sessionStoreReady = false;
        }
    }
    const competitionConfigReady = getCompetitionStatus().status !== 'invalid';
    const ready = databaseReady && sessionStoreReady && competitionConfigReady;
    res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'not_ready',
        databaseReady,
        sessionStoreReady,
        competitionConfigReady
    });
});
app.get('/', (req, res) => {
    const teamId = req.session.teamId;
    if (teamId) {
        return res.redirect('/platform');
    }
    res.render('login');
});

app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', rateLimits.login, async (req, res) => {
    try {
        const { teamId, password } = req.body;
        if (!isNonEmptyString(teamId, 50) || !isNonEmptyString(password, 200)) {
            return res.status(400).render('login', { error: 'Please enter a valid team ID and password' });
        }

        let team;
        if (isConnected) {
            team = await Team.findOne({ teamId: teamId.toUpperCase(), isActive: true });
            if (!team) {
                return res.status(401).render('login', { error: 'Invalid team ID or password' });
            }
            if (team.isAccessExpired()) {
                return res.status(401).render('login', { error: 'This team account has expired' });
            }
            const isValidPassword = await team.comparePassword(password);
            if (!isValidPassword) {
                return res.status(401).render('login', { error: 'Invalid team ID or password' });
            }
            await team.updateLoginTime();
            if (!await Score.exists({ teamId: team.teamId })) await createInitialScore(team.teamId);
        } else {
            team = await storage.findTeam(teamId.toUpperCase());
            if (!team) {
                return res.status(401).render('login', { error: 'Invalid team ID or password' });
            }
            const isValidPassword = await team.comparePassword(password);
            if (!isValidPassword) {
                return res.status(401).render('login', { error: 'Invalid team ID or password' });
            }
            await team.updateLoginTime();
            if (!await storage.findScore(team.teamId)) {
                await storage.createScore({
                    teamId: team.teamId,
                    problems: {
                        1: { status: 'unsolved', trials: 0, penalty: 0 },
                        2: { status: 'unsolved', trials: 0, penalty: 0 },
                        3: { status: 'unsolved', trials: 0, penalty: 0 },
                        4: { status: 'unsolved', trials: 0, penalty: 0 }
                    },
                    totalScore: 0,
                    totalPenalty: 0,
                    totalTrials: 0
                });
            }
        }

        await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
        req.session.teamId = team.teamId;
        req.session.save((err) => {
            if (err) {
                console.error('Session save error:', err);
                return res.render('login', { error: 'Login failed. Please try again.' });
            }
            res.redirect('/platform');
        });

    } catch (error) {
        console.error('Login error:', error.message);
        res.status(500).render('login', { error: 'An error occurred. Please try again.' });
    }
});

let platformProblemsCache = null;
const getPlatformProblems = async () => {
    if (platformProblemsCache) return platformProblemsCache;
    const rawProblems = await Problem.find({}).sort({ section: 1, number: 1 }).lean();
    platformProblemsCache = rawProblems.map(problem => ({
        ...problem,
        sections: Object.entries(problem.sections || {}).map(([key, value]) => ({
            name: key,
            title: value.title,
            description: value.description,
            maxPoints: value.maxPoints
        }))
    }));
    return platformProblemsCache;
};

app.get('/platform', requireAuth, async (req, res) => {
    try {
        const competitionStatus = getCompetitionStatus();
        let teamData, announcements = [], clarifications = [], problems = [];

        if (isConnected) {
            [teamData, announcements, clarifications, problems] = await Promise.all([
                Score.findOne({ teamId: req.teamId }).select('teamId totalScore totalPenalty totalTrials').lean(),
                Announcement.find({ isPublic: true }).sort({ createdAt: -1 }).limit(10).lean(),
                ClarificationRequest.find({
                    $and: [
                        { status: 'answered' },
                        { $or: [{ teamId: req.teamId }, { isPublic: true }] }
                    ]
                }).sort({ answeredAt: -1 }).limit(20).lean(),
                getPlatformProblems()
            ]);
        } else {
            teamData = await storage.findScore(req.teamId);
        }
        
        res.render('platform', {
            teamId: req.teamId,
            user: { teamId: req.teamId }, // Add user object for EJS compatibility
            competitionStatus,
            teamData,
            announcements,
            clarifications,
            problems,
            startTime: process.env.COMPETITION_START_TIME,
            endTime: process.env.COMPETITION_END_TIME
        });
    } catch (error) {
        console.error('Platform error:', error);
        res.redirect('/login');
    }
});

// Main problem route - shows all subtasks for a problem
app.get('/problem/:id', requireAuth, async (req, res) => {
    const problemId = parseProblemId(req.params.id);
    const competitionStatus = getCompetitionStatus();
    
    if (competitionStatus.status !== 'active') {
        return res.redirect('/platform');
    }
    
    if (!problemId) {
        return res.redirect('/platform');
    }
    
    try {
        let problemData = null;
        
        if (isConnected) {
            const rawProblem = (await getPlatformProblems()).find(problem => problem.id === problemId);
            if (rawProblem) {
                problemData = {
                    id: rawProblem.id,
                    section: rawProblem.section,
                    number: rawProblem.number,
                    title: rawProblem.title,
                    description: rawProblem.description,
                    maxPoints: rawProblem.maxPoints,
                    sections: rawProblem.sections
                };
            }
        }
        
        res.render('problem', {
            problemId: problemId,
            problemData: problemData,
            teamId: req.session.teamId,
            competitionStatus: competitionStatus
        });
    } catch (error) {
        console.error('Problem route error:', error);
        res.redirect('/platform');
    }
});

// Legacy route for backward compatibility - redirect to main problem page
app.get('/problem/:id/:section', requireAuth, (req, res) => {
    const problemId = parseProblemId(req.params.id);
    if (!problemId) return res.redirect('/platform');
    res.redirect(`/problem/${problemId}`);
});

// Get submission status for all sections of a problem
app.get('/submission-status/:problemId', requireAuth, async (req, res) => {
    try {
        const problemId = parseProblemId(req.params.problemId);
        if (!problemId) return res.status(422).json({ success: false, statuses: {}, message: 'Invalid problem ID' });
        
        if (!isConnected) {
            return res.status(503).json({ success: false, statuses: {}, message: 'Database not connected' });
        }

        const statuses = {};
        
        const problem = (await getPlatformProblems()).find(candidate => candidate.id === problemId);
        if (problem?.sections) {
            const submissions = await Submission.find({
                teamId: req.teamId,
                problemId
            }).select('section status submittedAt').sort({ submittedAt: -1 }).lean();
            const latestBySection = new Map();
            const wrongBySection = new Map();
            for (const submission of submissions) {
                const sectionName = String(submission.section);
                if (!latestBySection.has(sectionName)) latestBySection.set(sectionName, submission);
                if (submission.status === 'wrong') {
                    wrongBySection.set(sectionName, (wrongBySection.get(sectionName) || 0) + 1);
                }
            }

            for (const { name: sectionName, maxPoints } of problem.sections) {
                const latestSubmission = latestBySection.get(String(sectionName));

                if (!latestSubmission) {
                    statuses[sectionName] = { status: 'none' };
                    continue;
                }

                if (latestSubmission.status === 'correct') {
                    statuses[sectionName] = {
                        status: 'correct',
                        score: resolveSubtaskPoints(maxPoints),
                        submittedAt: latestSubmission.submittedAt
                    };
                } else if (latestSubmission.status === 'pending') {
                    statuses[sectionName] = {
                        status: 'pending',
                        submittedAt: latestSubmission.submittedAt
                    };
                } else if (latestSubmission.status === 'wrong') {
                    const wrongSubmissions = wrongBySection.get(String(sectionName)) || 0;
                    
                    statuses[sectionName] = {
                        status: 'can_submit', // Allow resubmission after wrong answer
                        penalties: wrongSubmissions,
                        message: `${wrongSubmissions} wrong attempt(s)`,
                        submittedAt: latestSubmission.submittedAt
                    };
                } else {
                    const wrongSubmissions = wrongBySection.get(String(sectionName)) || 0;
                    
                    statuses[sectionName] = {
                        status: 'can_submit',
                        penalties: wrongSubmissions
                    };
                }
            }
        }
        
        res.json({ success: true, statuses });
    } catch (error) {
        console.error('Error checking submission statuses:', error);
        res.status(500).json({ success: false, statuses: {}, message: 'Error checking submission status' });
    }
});

// Get submission status for a specific problem section
app.get('/submission-status/:problemId/:section', requireAuth, async (req, res) => {
    try {
        const problemId = parseProblemId(req.params.problemId);
        const section = normalizeSection(req.params.section);
        if (!problemId || !section) return res.status(422).json({ status: 'error', message: 'Invalid problem or subtask' });
        
        if (!isConnected) {
            return res.status(503).json({ status: 'none', message: 'Database not connected' });
        }

        const problem = (await getPlatformProblems()).find(candidate => candidate.id === problemId);
        const subtask = problem?.sections.find(candidate => candidate.name === section);
        if (!subtask) return res.status(422).json({ status: 'error', message: 'Problem or subtask not found' });

        // Find the latest submission for this team, problem, and section
        const latestSubmission = await Submission.findOne({
            teamId: req.teamId,
            problemId: problemId,
            section: section
        }).sort({ submittedAt: -1 });

        if (!latestSubmission) {
            return res.json({ status: 'none' });
        }

        // If the submission is correct, prevent further submissions
        if (latestSubmission.status === 'correct') {
            return res.json({
                status: 'correct',
                score: resolveSubtaskPoints(subtask.maxPoints),
                submittedAt: latestSubmission.submittedAt,
                message: 'This section has already been solved correctly'
            });
        }

        // If there's a pending submission, prevent new submissions
        if (latestSubmission.status === 'pending') {
            return res.json({
                status: 'pending',
                submittedAt: latestSubmission.submittedAt,
                message: 'Previous submission is under review'
            });
        }

        // Get penalty count for wrong submissions
        const wrongSubmissions = await Submission.countDocuments({
            teamId: req.teamId,
            problemId: problemId,
            section: section,
            status: 'wrong'
        });

        // Return appropriate status based on latest submission
        if (latestSubmission.status === 'wrong') {
            return res.json({
                status: 'can_submit', // Allow resubmission after wrong answer
                penalties: wrongSubmissions,
                message: `Previous submission was incorrect. You have ${wrongSubmissions} wrong attempt(s).`,
                submittedAt: latestSubmission.submittedAt
            });
        }

        return res.json({
            status: latestSubmission.status,
            penalties: wrongSubmissions,
            submittedAt: latestSubmission.submittedAt
        });

    } catch (error) {
        console.error('Error checking submission status:', error);
        res.status(500).json({ status: 'error', message: 'Error checking submission status' });
    }
});

app.post('/submit/:problemId/:section', requireAuth, rateLimits.submission, upload.none(), async (req, res) => {
    try {
        const problemId = parseProblemId(req.params.problemId);
        const section = normalizeSection(req.params.section);
        const competitionStatus = getCompetitionStatus();

        if (competitionStatus.status !== 'active') {
            return res.status(409).json({ success: false, message: 'Competition is not active' });
        }
        if (!problemId || !section) {
            return res.status(422).json({ success: false, message: 'Invalid problem or subtask' });
        }
        const { language, code } = req.body;
        if (!isNonEmptyString(language, 10) || !isNonEmptyString(code, maxCodeBytes)) {
            return res.status(422).json({ success: false, message: 'Language and code are required' });
        }
        if (!['py', 'cpp'].includes(language)) {
            return res.status(422).json({ success: false, message: 'Invalid language. Only Python and C++ are supported.' });
        }
        const codeLength = Buffer.byteLength(code, 'utf8');
        if (codeLength < 10 || codeLength > maxCodeBytes) {
            return res.status(codeLength > maxCodeBytes ? 413 : 422).json({ success: false, message: codeLength > maxCodeBytes ? 'Code exceeds the configured size limit' : 'Code too short' });
        }
        const submissionData = {
            teamId: req.teamId, problemId, section, language, code, codeLength,
            codeHash: crypto.createHash('sha256').update(code, 'utf8').digest('hex'),
            reviewStatus: 'under_review',
            status: 'pending',
            submittedAt: new Date()
        };
        let submission;
        if (isConnected) {
            const mongoSession = await mongoose.startSession();
            try {
                await mongoSession.withTransaction(async () => {
                    const problem = await Problem.findOne({ id: problemId }).session(mongoSession);
                    if (!problem || !problem.sections.has(section)) {
                        const validationError = new Error('Problem or subtask not found');
                        validationError.statusCode = 422;
                        throw validationError;
                    }
                    const conflict = await Submission.exists({
                        teamId: req.teamId, problemId, section, status: { $in: ['pending', 'correct'] }
                    }).session(mongoSession);
                    if (conflict) {
                        const conflictError = new Error('This subtask already has a pending or correct submission');
                        conflictError.statusCode = 409;
                        throw conflictError;
                    }
                    submission = new Submission(submissionData);
                    await submission.save({ session: mongoSession });
                    let score = await Score.findOne({ teamId: req.teamId }).session(mongoSession);
                    if (!score) score = await createInitialScore(req.teamId, mongoSession);
                    score.recordSubmissionAttempt(problemId, section);
                    await score.save({ session: mongoSession });
                });
            } finally {
                await mongoSession.endSession();
            }
        } else {
            submission = await storage.createSubmission(submissionData);
            const score = await storage.findScore(req.teamId);
            if (score) await score.incrementTrials(problemId);
        }
        res.status(201).json({ success: true, message: 'Solution submitted successfully!', submissionId: String(submission._id) });
    } catch (error) {
        if (error.code === 11000 || error.statusCode === 409) {
            return res.status(409).json({ success: false, message: error.message || 'A pending submission already exists' });
        }
        if (error.statusCode === 422) return res.status(422).json({ success: false, message: error.message });
        console.error('Submission error:', error.message);
        res.status(500).json({ success: false, message: 'Error submitting solution' });
    }
});

// Clarification request route
app.post('/clarification', requireAuth, rateLimits.clarification, async (req, res) => {
    try {
        const { problemId, question } = req.body;
        const parsedProblemId = parseProblemId(problemId);
        if (!parsedProblemId || !isNonEmptyString(question, 2000)) {
            return res.status(422).json({ success: false, message: 'Please provide a valid problem and a question under 2,000 characters' });
        }
        const clarificationData = {
            teamId: req.teamId,
            problemId: parsedProblemId,
            question: question.trim()
        };
        if (isConnected) {
            if (!await Problem.exists({ id: parsedProblemId })) {
                return res.status(422).json({ success: false, message: 'Problem not found' });
            }
            const clarification = new ClarificationRequest(clarificationData);
            await clarification.save();
        }
        res.status(201).json({ success: true, message: 'Clarification request submitted successfully!' });
    } catch (error) {
        console.error('Clarification submission error:', error.message);
        res.status(500).json({ success: false, message: 'Error submitting clarification request' });
    }
});

const scoreboardCacheMs = Number(process.env.SCOREBOARD_CACHE_MS || 5000);
const scoreboardHtmlCache = { html: null, refreshedAt: 0, refreshPromise: null, stateKey: null };
const frozenScoreboardHtmlCache = new Map();

const buildScoreboardViewModel = async () => {
    if (!isConnected) {
        const memoryScores = await storage.getAllScores();
        return { scoreboard: memoryScores, problems: [], problemsBySection: {} };
    }

    const [teams, scores, allProblems] = await Promise.all([
        Team.find({}).select('teamId teamName').lean(),
        Score.find({}).select('teamId totalScore totalPenalty problems').lean(),
        Problem.find({}).sort({ section: 1, number: 1 })
    ]);
    const scoreByTeam = new Map(scores.map(score => [score.teamId, score]));
    const problemsBySection = {};
    allProblems.forEach(problem => {
        problemsBySection[problem.section] ||= [];
        problemsBySection[problem.section].push({
            id: problem.id,
            title: problem.title,
            sections: problem.sections || new Map()
        });
    });

    const scoreboard = teams.map(team => {
        const teamScore = scoreByTeam.get(team.teamId);
        const problemScores = {};
        for (const [problemId, problemData] of Object.entries(teamScore?.problems || {})) {
            const sections = new Map();
            let problemPenalty = 0;
            for (const [sectionId, sectionData] of Object.entries(problemData.sections || {})) {
                sections.set(sectionId, {
                    status: sectionData.status || 'unsolved',
                    trials: sectionData.trials || 0,
                    score: sectionData.score || 0,
                    penalty: sectionData.penalty || 0
                });
                problemPenalty += sectionData.penalty || 0;
            }
            problemScores[problemId] = {
                totalScore: problemData.totalScore || 0,
                totalPenalty: problemPenalty,
                status: problemData.status || 'unsolved',
                sections
            };
        }
        return {
            teamId: team.teamId,
            teamName: team.teamName || team.teamId,
            totalScore: teamScore?.totalScore || 0,
            totalPenalty: teamScore?.totalPenalty || 0,
            problems: problemScores
        };
    });

    scoreboard.sort((a, b) => b.totalScore - a.totalScore || a.totalPenalty - b.totalPenalty);
    return { scoreboard, problems: allProblems, problemsBySection };
};

const buildFrozenScoreboardViewModel = async cutoff => {
    if (!isConnected) return buildScoreboardViewModel();
    const [teams, allProblems, submissions, auditLogs] = await Promise.all([
        Team.find({}).select('teamId teamName').lean(),
        Problem.find({}).sort({ section: 1, number: 1 }),
        Submission.find({ submittedAt: { $lte: cutoff } })
            .select('teamId problemId section submittedAt status reviewStatus reviewedAt')
            .lean(),
        AuditLog.find({
            action: { $in: ['score.section.update', 'score.problem.update'] },
            createdAt: { $lte: cutoff }
        }).select('action metadata createdAt').lean()
    ]);
    const problemsBySection = {};
    for (const problem of allProblems) {
        problemsBySection[problem.section] ||= [];
        problemsBySection[problem.section].push({ id: problem.id, title: problem.title, sections: problem.sections || new Map() });
    }
    return {
        scoreboard: buildHistoricalScoreboard({
            teams,
            problems: allProblems,
            submissions,
            auditLogs,
            cutoff,
            wrongPenaltyMinutes: resolvePenaltyMinutes(process.env.PENALTY_MINUTES_PER_WRONG)
        }),
        problems: allProblems,
        problemsBySection
    };
};

const renderScoreboardHtml = viewModel => new Promise((resolve, reject) => {
    app.render('scoreboard', viewModel, (error, html) => error ? reject(error) : resolve(html));
});

const refreshScoreboardCache = async (scoreboardState, stateKey) => {
    const html = await renderScoreboardHtml({ ...await buildScoreboardViewModel(), scoreboardState });
    scoreboardHtmlCache.html = html;
    scoreboardHtmlCache.refreshedAt = Date.now();
    scoreboardHtmlCache.stateKey = stateKey;
    return html;
};

const startScoreboardRefresh = (scoreboardState, stateKey) => {
    if (!scoreboardHtmlCache.refreshPromise) {
        scoreboardHtmlCache.refreshPromise = refreshScoreboardCache(scoreboardState, stateKey)
            .finally(() => { scoreboardHtmlCache.refreshPromise = null; });
    }
    return scoreboardHtmlCache.refreshPromise;
};

app.get('/scoreboard', async (req, res) => {
    try {
        const competitionStatus = getCompetitionStatus();
        const adminLiveView = Boolean(req.session.isAdmin && req.query.live === '1');
        const scoreboardState = {
            isFrozen: competitionStatus.isScoreboardFrozen && !adminLiveView,
            isAdminLive: adminLiveView,
            freezeTime: competitionStatus.scoreboardFreezeTime,
            endTime: competitionStatus.endTime,
            blindMinutes: competitionStatus.blindMinutes
        };

        if (scoreboardState.isFrozen) {
            const cacheKey = competitionStatus.scoreboardFreezeTime.toISOString();
            if (!frozenScoreboardHtmlCache.has(cacheKey)) {
                const viewModel = await buildFrozenScoreboardViewModel(competitionStatus.scoreboardFreezeTime);
                frozenScoreboardHtmlCache.set(cacheKey, await renderScoreboardHtml({ ...viewModel, scoreboardState }));
            }
            return res.type('html').send(frozenScoreboardHtmlCache.get(cacheKey));
        }

        if (adminLiveView) {
            return res.type('html').send(await renderScoreboardHtml({ ...await buildScoreboardViewModel(), scoreboardState }));
        }
        const stateKey = competitionStatus.status;
        if (!scoreboardHtmlCache.html || scoreboardHtmlCache.stateKey !== stateKey) {
            await startScoreboardRefresh(scoreboardState, stateKey);
            if (scoreboardHtmlCache.stateKey !== stateKey) await startScoreboardRefresh(scoreboardState, stateKey);
        }
        else if (Date.now() - scoreboardHtmlCache.refreshedAt >= scoreboardCacheMs) {
            startScoreboardRefresh(scoreboardState, stateKey).catch(error => console.error('Scoreboard refresh error:', error.message));
        }
        res.type('html').send(scoreboardHtmlCache.html);
    } catch (error) {
        console.error('Scoreboard error:', error);
        res.render('scoreboard', { scoreboard: [], problems: [], problemsBySection: {}, scoreboardState: { isFrozen: false, isAdminLive: false } });
    }
});

app.post('/logout', (req, res) => destroySession(req, res));

// Admin routes
app.get('/admin/login', (req, res) => {
    res.render('admin-login');
});

app.post('/admin/login', rateLimits.login, async (req, res) => {
    const { username, password } = req.body;
    const adminIdentity = resolveAdminIdentity(username, password);
    if (adminIdentity) {
        await new Promise((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
        req.session.isAdmin = true;
        req.session.adminRole = adminIdentity.role;
        req.session.adminActor = adminIdentity.actor;
        req.session.save((err) => {
            if (err) {
                console.error('Admin session save error:', err);
                return res.render('admin-login', { error: 'Login failed. Please try again.' });
            }
            res.redirect('/admin');
        });
    } else {
        res.status(401).render('admin-login', { error: 'Invalid credentials' });
    }
});

app.get('/admin', requireAdmin, async (req, res) => {
    try {
        let scoreboardArray = [];
        let submissionsArray = [];
        let announcementsArray = [];
        let clarificationsArray = [];
        let selectedTeamScore = null;
        const selectedTeamId = isNonEmptyString(req.query.teamId, 50) ? req.query.teamId.trim().toUpperCase() : null;

        if (isConnected) {
            const [scores, submissions, announcements, clarifications, selectedScore, allProblems] = await Promise.all([
                Score.find().select('teamId totalScore totalPenalty totalTrials').sort({ totalScore: -1, totalPenalty: 1 }).lean(),
                Submission.aggregate([
                    { $sort: { submittedAt: -1 } },
                    { $limit: 50 },
                    { $project: {
                        teamId: 1, problemId: 1, section: 1, language: 1, codeLength: 1,
                        submittedAt: 1, reviewStatus: 1, status: 1, reviewNotes: 1,
                        codePreview: { $substrCP: ['$code', 0, 100] }
                    } }
                ]),
                Announcement.find().sort({ createdAt: -1 }).limit(20),
                ClarificationRequest.find().sort({ submittedAt: -1 }).limit(50),
                selectedTeamId ? Score.findOne({ teamId: selectedTeamId }) : Promise.resolve(null),
                selectedTeamId ? Problem.find({}).sort({ section: 1, number: 1 }) : Promise.resolve([])
            ]);

            scoreboardArray = scores.map(score => ({
                teamId: score.teamId,
                totalScore: score.totalScore,
                penalties: score.totalPenalty,
                trials: score.totalTrials
            }));

            if (selectedScore) {
                selectedTeamScore = {
                    teamId: selectedScore.teamId,
                    totalScore: selectedScore.totalScore,
                    totalPenalty: selectedScore.totalPenalty,
                    totalTrials: selectedScore.totalTrials,
                    problems: allProblems.map(problem => {
                        const problemScore = selectedScore.problems.get(String(problem.id));
                        return {
                            id: problem.id,
                            displayId: `${problem.section}.${problem.number}`,
                            title: problem.title,
                            totalScore: problemScore?.totalScore || 0,
                            status: problemScore?.status || 'unsolved',
                            sections: [...problem.sections.keys()].map(sectionId => {
                                const sectionScore = problemScore?.sections.get(String(sectionId));
                                const sectionDefinition = problem.sections.get(String(sectionId));
                                return {
                                    id: String(sectionId),
                                    maxPoints: resolveSubtaskPoints(sectionDefinition?.maxPoints),
                                    status: sectionScore?.status || 'unsolved',
                                    score: sectionScore?.score || 0,
                                    trials: sectionScore?.trials || 0,
                                    penalty: sectionScore?.penalty || 0
                                };
                            })
                        };
                    })
                };
            }

            submissionsArray = submissions.map(sub => ({
                _id: sub._id,
                teamId: sub.teamId,
                problemId: sub.problemId,
                section: sub.section,
                language: sub.language,
                codePreview: sub.codePreview ? sub.codePreview + ((sub.codeLength || 0) > 100 ? '...' : '') : 'No code',
                codeLength: sub.codeLength || 0,
                timestamp: sub.submittedAt,
                reviewStatus: sub.reviewStatus,
                status: sub.status,
                reviewNotes: sub.reviewNotes
            }));

            announcementsArray = announcements;
            clarificationsArray = clarifications;
        } else {
            const scores = await storage.getAllScores();
            const submissions = await storage.getRecentSubmissions(50);

            scoreboardArray = scores.map(score => ({
                teamId: score.teamId,
                totalScore: score.totalScore,
                penalties: score.totalPenalty,
                trials: score.totalTrials,
                problems: score.problems
            }));

            submissionsArray = submissions.map(sub => ({
                teamId: sub.teamId,
                problemId: sub.problemId,
                section: sub.section,
                filename: sub.originalName,
                timestamp: sub.submittedAt
            }));

            const selectedScore = selectedTeamId ? await storage.findScore(selectedTeamId) : null;
            if (selectedScore) {
                selectedTeamScore = {
                    teamId: selectedScore.teamId,
                    totalScore: selectedScore.totalScore || 0,
                    totalPenalty: selectedScore.totalPenalty || 0,
                    totalTrials: selectedScore.totalTrials || 0,
                    problems: Object.entries(selectedScore.problems || {}).map(([problemId, problemScore]) => ({
                        id: problemId,
                        title: `Problem ${problemId}`,
                        totalScore: problemScore.totalScore || 0,
                        status: problemScore.status || 'unsolved',
                        sections: Object.entries(problemScore.sections || {}).map(([sectionId, sectionScore]) => ({
                            id: sectionId,
                            status: sectionScore.status || 'unsolved',
                            score: sectionScore.score || 0,
                            trials: sectionScore.trials || 0,
                            penalty: sectionScore.penalty || 0
                        }))
                    }))
                };
            }
        }

        res.render('admin', { 
            scoreboard: scoreboardArray, 
            submissions: submissionsArray,
            announcements: announcementsArray,
            clarifications: clarificationsArray,
            selectedTeamScore,
            selectedTeamId,
            adminRole: req.adminRole
        });
    } catch (error) {
        console.error('Admin panel error:', error.message);
        res.status(500).render('admin', {
            scoreboard: [], submissions: [], announcements: [], clarifications: [],
            selectedTeamScore: null, selectedTeamId: null, adminRole: req.adminRole
        });
    }
});

app.post('/admin/update-section', requireAdmin, rateLimits.admin, async (req, res) => {
    try {
        const { teamId, problemId, section, status } = req.body;
        const parsedProblemId = parseProblemId(problemId);
        const parsedSection = normalizeSection(section);
        if (!isNonEmptyString(teamId, 50) || !parsedProblemId || !parsedSection || !['correct', 'wrong', 'unsolved'].includes(status)) {
            return res.status(422).json({ success: false, message: 'Invalid score update' });
        }
        if (isConnected) {
            const score = await Score.findOne({ teamId: teamId.toUpperCase() });
            if (!score) {
                return res.status(404).json({ success: false, message: 'Team not found' });
            }
            score.updateSection(parsedProblemId, parsedSection, status);
            await score.save();
            await AuditLog.create({
                action: 'score.section.update', actor: req.adminActor, targetType: 'Score', targetId: String(score._id),
                metadata: { teamId: score.teamId, problemId: parsedProblemId, section: parsedSection, status }
            });
        } else {
            const score = await storage.findScore(teamId);
            if (!score) {
                return res.status(404).json({ success: false, message: 'Team not found' });
            }
            await score.updateSection(parsedProblemId, parsedSection, status);
        }
        res.json({ success: true });
    } catch (error) {
        console.error('Section update error:', error.message);
        res.status(500).json({ success: false, message: 'Error updating section' });
    }
});

app.post('/admin/update-score', requireAdmin, rateLimits.admin, async (req, res) => {
    try {
        const { teamId, problemId, status } = req.body;
        const parsedProblemId = parseProblemId(problemId);
        if (!isNonEmptyString(teamId, 50) || !parsedProblemId || !['correct', 'wrong', 'unsolved'].includes(status)) {
            return res.status(422).json({ success: false, message: 'Invalid problem score update' });
        }
        if (isConnected) {
            const score = await Score.findOne({ teamId: teamId.toUpperCase() });
            if (!score) {
                return res.status(404).json({ success: false, message: 'Team not found' });
            }
            score.updateProblem(parsedProblemId, status);
            await score.save();
            await AuditLog.create({
                action: 'score.problem.update', actor: req.adminActor, targetType: 'Score', targetId: String(score._id),
                metadata: { teamId: score.teamId, problemId: parsedProblemId, status }
            });
        } else {
            const score = await storage.findScore(teamId);
            if (!score) {
                return res.status(404).json({ success: false, message: 'Team not found' });
            }

            await score.updateProblem(parsedProblemId, status);
        }

        res.json({ success: true });

    } catch (error) {
        console.error('Score update error:', error.message);
        res.status(500).json({ success: false, message: 'Error updating score' });
    }
});

// Admin announcement routes
app.post('/admin/announcement', requireAdmin, rateLimits.admin, async (req, res) => {
    try {
        const { title, content, type, priority, isPublic } = req.body;
        
        if (!isNonEmptyString(title, 200) || !isNonEmptyString(content, 5000)) {
            return res.status(422).json({ success: false, message: 'A valid title and content are required' });
        }
        if (type && !['announcement', 'clarification'].includes(type)) {
            return res.status(422).json({ success: false, message: 'Invalid announcement type' });
        }
        if (priority && !['low', 'medium', 'high', 'urgent'].includes(priority)) {
            return res.status(422).json({ success: false, message: 'Invalid announcement priority' });
        }

        if (isConnected) {
            const announcement = new Announcement({
                title: title.trim(),
                content: content.trim(),
                type: type || 'announcement',
                priority: priority || 'medium',
                isPublic: parseBoolean(isPublic)
            });
            await announcement.save();
            await AuditLog.create({ action: 'announcement.create', actor: req.adminActor, targetType: 'Announcement', targetId: String(announcement._id) });
        }

        res.status(201).json({ success: true, message: 'Announcement created successfully' });
    } catch (error) {
        console.error('Announcement creation error:', error.message);
        res.status(500).json({ success: false, message: 'Error creating announcement' });
    }
});

app.post('/admin/clarification/answer', requireAdmin, rateLimits.admin, async (req, res) => {
    try {
        const { clarificationId, answer, isPublic } = req.body;
        
        if (!mongoose.isValidObjectId(clarificationId) || !isNonEmptyString(answer, 5000)) {
            return res.status(422).json({ success: false, message: 'A valid clarification ID and answer are required' });
        }

        if (isConnected) {
            const clarification = await ClarificationRequest.findById(clarificationId);
            if (!clarification) {
                return res.status(404).json({ success: false, message: 'Clarification not found' });
            }

            clarification.answer = answer.trim();
            clarification.status = 'answered';
            clarification.isPublic = parseBoolean(isPublic);
            clarification.answeredAt = new Date();
            
            await clarification.save();
            await AuditLog.create({ action: 'clarification.answer', actor: req.adminActor, targetType: 'ClarificationRequest', targetId: String(clarification._id), metadata: { isPublic: clarification.isPublic } });
        }

        res.json({ success: true, message: 'Clarification answered successfully' });
    } catch (error) {
        console.error('Clarification answer error:', error.message);
        res.status(500).json({ success: false, message: 'Error answering clarification' });
    }
});

// Admin submission review routes
app.post('/admin/review-submission', requireAdmin, rateLimits.admin, async (req, res) => {
    try {
        const { submissionId, decision, notes } = req.body;
        if (!mongoose.isValidObjectId(submissionId) || !['correct', 'wrong'].includes(decision) || (notes != null && typeof notes !== 'string') || String(notes || '').length > 2000) {
            return res.status(422).json({ success: false, message: 'A valid submission ID, decision, and notes are required' });
        }
        if (!isConnected) {
            return res.status(503).json({ success: false, message: 'Submission review requires MongoDB' });
        }
        const wrongPenalty = resolvePenaltyMinutes(process.env.PENALTY_MINUTES_PER_WRONG);
        let updatedScore;
        const mongoSession = await mongoose.startSession();
        try {
            await mongoSession.withTransaction(async () => {
                const submission = await Submission.findById(submissionId).session(mongoSession);
                if (!submission) {
                    const notFound = new Error('Submission not found');
                    notFound.statusCode = 404;
                    throw notFound;
                }
                if (submission.reviewStatus === 'reviewed') {
                    const conflict = new Error('Submission has already been reviewed');
                    conflict.statusCode = 409;
                    throw conflict;
                }
                const score = await Score.findOne({ teamId: submission.teamId }).session(mongoSession);
                if (!score) throw new Error('Score record not found');

                submission.status = decision;
                submission.reviewStatus = 'reviewed';
                submission.reviewedAt = new Date();
                submission.reviewedBy = req.adminActor;
                submission.reviewNotes = String(notes || '').trim();
                score.applyReview(submission.problemId, submission.section, decision, wrongPenalty);

                await submission.save({ session: mongoSession });
                await score.save({ session: mongoSession });
                await AuditLog.create([{
                    action: 'submission.review', actor: req.adminActor, targetType: 'Submission', targetId: String(submission._id),
                    metadata: { decision, teamId: submission.teamId, problemId: submission.problemId, section: submission.section }
                }], { session: mongoSession });
                updatedScore = score;
            });
        } finally {
            await mongoSession.endSession();
        }
        res.json({
            success: true,
            message: 'Submission reviewed successfully',
            score: { totalScore: updatedScore.totalScore, totalPenalty: updatedScore.totalPenalty, totalTrials: updatedScore.totalTrials }
        });
    } catch (error) {
        if ([404, 409].includes(error.statusCode)) return res.status(error.statusCode).json({ success: false, message: error.message });
        console.error('Submission review error:', error.message);
        res.status(500).json({ success: false, message: 'Error reviewing submission' });
    }
});

// Get full submission code
app.get('/admin/submission/:id/code', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) return res.status(422).json({ success: false, message: 'Invalid submission ID' });
        if (isConnected) {
            const submission = await Submission.findById(id);
            if (!submission) {
                return res.status(404).json({ success: false, message: 'Submission not found' });
            }
            
            res.json({ 
                success: true, 
                code: submission.code,
                language: submission.language,
                teamId: submission.teamId,
                problemId: submission.problemId,
                section: submission.section
            });
        } else {
            res.status(503).json({ success: false, message: 'Feature not available in memory mode' });
        }
    } catch (error) {
        console.error('Get code error:', error.message);
        res.status(500).json({ success: false, message: 'Error fetching code' });
    }
});

// Get unreviewed submissions count
app.get('/admin/unreviewed-count', requireAdmin, async (req, res) => {
    try {
        let count = 0;
        
        if (isConnected) {
            count = await Submission.countDocuments({ reviewStatus: 'under_review' });
        }
        
        res.json({ count });
    } catch (error) {
        console.error('Unreviewed count error:', error.message);
        res.status(500).json({ count: 0 });
    }
});

app.delete('/admin/announcement/:id', requireAdmin, rateLimits.admin, async (req, res) => {
    try {
        const { id } = req.params;
        if (!mongoose.isValidObjectId(id)) return res.status(422).json({ success: false, message: 'Invalid announcement ID' });
        if (isConnected) {
            const deleted = await Announcement.findByIdAndDelete(id);
            if (!deleted) return res.status(404).json({ success: false, message: 'Announcement not found' });
            await AuditLog.create({ action: 'announcement.delete', actor: req.adminActor, targetType: 'Announcement', targetId: id });
        }

        res.json({ success: true, message: 'Announcement deleted successfully' });
    } catch (error) {
        console.error('Announcement deletion error:', error.message);
        res.status(500).json({ success: false, message: 'Error deleting announcement' });
    }
});

app.post('/admin/logout', (req, res) => destroySession(req, res));

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError || error.type === 'entity.too.large') {
        return res.status(413).json({ success: false, message: 'Request exceeds the configured size limit' });
    }
    console.error('Unhandled request error:', error.message);
    if (expectsJson(req)) return res.status(500).json({ success: false, message: 'Internal server error' });
    res.status(500).send('Internal server error');
});

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMainModule) {
    app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

export default app;
