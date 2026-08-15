// In-memory storage fallback when MongoDB is not available
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { DEFAULT_SUBTASK_POINTS, resolveSubtaskPoints } from './scoring.js';

class InMemoryStorage {
    constructor() {
        this.teams = new Map();
        this.scores = new Map();
        this.submissions = new Map();
        this.sessions = new Map();
        this.announcements = new Map();
        this.clarifications = new Map();
    }

    // Team operations
    async findTeam(teamId) {
        return this.teams.get(teamId.toUpperCase()) || null;
    }

    async createTeam(teamData) {
        const team = {
            ...teamData,
            teamId: teamData.teamId.toUpperCase(),
            password: await bcrypt.hash(teamData.password, 10),
            createdAt: new Date(),
            loginTime: null,
            isActive: true,
            comparePassword: function(password) {
                return bcrypt.compare(password, this.password);
            },
            updateLoginTime: function() {
                this.loginTime = new Date();
                return Promise.resolve(this);
            }
        };
        this.teams.set(team.teamId, team);
        return team;
    }

    // Score operations
    async findScore(teamId) {
        return this.scores.get(teamId) || null;
    }

    async createScore(scoreData) {
        const score = {
            ...scoreData,
            calculateTotals: function() {
                this.totalScore = 0;
                this.totalPenalty = 0;
                this.totalTrials = 0;
                
                for (const problem of Object.values(this.problems || {})) {
                    const sections = Object.values(problem.sections || {});
                    if (sections.length > 0) {
                        problem.totalScore = sections.reduce((sum, section) => sum + Number(section.score || 0), 0);
                        this.totalScore += problem.totalScore;
                        this.totalPenalty += sections.reduce((sum, section) => sum + Number(section.penalty || 0), 0);
                        const sectionTrials = sections.reduce((sum, section) => sum + Number(section.trials || 0), 0);
                        this.totalTrials += sectionTrials || Number(problem.trials || 0);
                    } else {
                        this.totalScore += problem.status === 'correct' ? resolveSubtaskPoints(problem.maxPoints) : 0;
                        this.totalPenalty += Number(problem.penalty || 0);
                        this.totalTrials += Number(problem.trials || 0);
                    }
                }
                
                this.lastUpdated = new Date();
                return this;
            },
            updateProblem: function(problemId, status) {
                const problem = this.problems[problemId];
                
                for (const section of Object.values(problem.sections || {})) {
                    section.status = status;
                    section.score = status === 'correct' ? resolveSubtaskPoints(section.maxPoints) : 0;
                }
                problem.status = status;
                problem.solvedAt = status === 'correct' ? (problem.solvedAt || new Date()) : null;
                
                this.calculateTotals();
                return Promise.resolve(this);
            },
            updateSection: function(problemId, section, status) {
                let problem = this.problems[problemId];
                if (!problem) {
                    this.problems[problemId] = {
                        sections: {
                            A: { status: 'unsolved', trials: 0 },
                            B: { status: 'unsolved', trials: 0 },
                            C: { status: 'unsolved', trials: 0 },
                            D: { status: 'unsolved', trials: 0 },
                            E: { status: 'unsolved', trials: 0 }
                        },
                        status: 'unsolved',
                        trials: 0,
                        penalty: 0
                    };
                    problem = this.problems[problemId];
                }
                
                if (!problem.sections) {
                    problem.sections = {
                        A: { status: 'unsolved', trials: 0 },
                        B: { status: 'unsolved', trials: 0 },
                        C: { status: 'unsolved', trials: 0 },
                        D: { status: 'unsolved', trials: 0 },
                        E: { status: 'unsolved', trials: 0 }
                    };
                }
                
                if (!problem.sections[section]) {
                    problem.sections[section] = {
                        status: 'unsolved', score: 0, maxPoints: DEFAULT_SUBTASK_POINTS, trials: 0, penalty: 0
                    };
                }
                
                // Update section status
                problem.sections[section].status = status;
                problem.sections[section].score = status === 'correct'
                    ? resolveSubtaskPoints(problem.sections[section].maxPoints)
                    : 0;
                
                // Update overall problem status based on section statuses
                const sections = problem.sections;
                const correctSections = Object.values(sections).filter(s => s.status === 'correct').length;
                const wrongSections = Object.values(sections).filter(s => s.status === 'wrong').length;
                
                if (correctSections === Object.keys(sections).length) {
                    problem.status = 'correct';
                    problem.solvedAt = new Date();
                } else if (correctSections > 0 || wrongSections > 0) {
                    problem.status = 'partial';
                } else {
                    problem.status = 'unsolved';
                    problem.solvedAt = null;
                }
                
                this.calculateTotals();
                return Promise.resolve(this);
            },
            incrementTrials: function(problemId) {
                this.problems[problemId].trials += 1;
                this.calculateTotals();
                return Promise.resolve(this);
            },
            save: function() {
                return Promise.resolve(this);
            }
        };
        
        this.scores.set(scoreData.teamId, score);
        return score;
    }

    async updateScore(teamId, updateData) {
        const score = this.scores.get(teamId);
        if (score) {
            Object.assign(score, updateData);
        }
        return score;
    }

    async getAllScores() {
        const scores = Array.from(this.scores.values());
        return scores.sort((a, b) => {
            if (a.totalScore !== b.totalScore) return b.totalScore - a.totalScore;
            return a.totalPenalty - b.totalPenalty;
        });
    }

    // Submission operations
    async createSubmission(submissionData) {
        const submission = {
            ...submissionData,
            _id: Date.now().toString(),
            submittedAt: new Date(),
            save: function() {
                return Promise.resolve(this);
            }
        };
        
        this.submissions.set(submission._id, submission);
        return submission;
    }

    async getRecentSubmissions(limit = 50) {
        const submissions = Array.from(this.submissions.values());
        return submissions
            .sort((a, b) => b.submittedAt - a.submittedAt)
            .slice(0, limit);
    }

    // Initialize with sample data
    async initializeSampleData() {
        console.log('🔄 Initializing sample data for in-memory storage...');
        
        // Create sample teams
        const devPassword = process.env.DEV_TEAM_PASSWORD || crypto.randomBytes(24).toString('base64url');
        const sampleTeams = [
            {
                teamId: 'TEAM001',
                password: devPassword,
                teamName: 'Code Warriors',
                members: [
                    { name: 'Ahmed Mohamed', email: 'ahmed@example.com', grade: '12' },
                    { name: 'Sara Ali', email: 'sara@example.com', grade: '11' }
                ],
                school: 'Cairo High School'
            },
            {
                teamId: 'TEAM002',
                password: devPassword,
                teamName: 'Algorithm Masters',
                members: [
                    { name: 'Omar Hassan', email: 'omar@example.com', grade: '12' },
                    { name: 'Fatma Gamal', email: 'fatma@example.com', grade: '12' }
                ],
                school: 'Alexandria STEM School'
            },
            {
                teamId: 'TEAM003',
                password: devPassword,
                teamName: 'Binary Builders',
                members: [
                    { name: 'Youssef Khaled', email: 'youssef@example.com', grade: '11' },
                    { name: 'Nour Mahmoud', email: 'nour@example.com', grade: '11' }
                ],
                school: 'Giza International School'
            }
        ];

        for (const teamData of sampleTeams) {
            await this.createTeam(teamData);
            
            // Create initial score for each team
            await this.createScore({
                teamId: teamData.teamId,
                problems: {
                    1: { 
                        sections: {
                            A: { status: 'unsolved', trials: 0 },
                            B: { status: 'unsolved', trials: 0 },
                            C: { status: 'unsolved', trials: 0 },
                            D: { status: 'unsolved', trials: 0 },
                            E: { status: 'unsolved', trials: 0 }
                        },
                        status: 'unsolved', trials: 0, penalty: 0 
                    },
                    2: { 
                        sections: {
                            A: { status: 'unsolved', trials: 0 },
                            B: { status: 'unsolved', trials: 0 },
                            C: { status: 'unsolved', trials: 0 },
                            D: { status: 'unsolved', trials: 0 },
                            E: { status: 'unsolved', trials: 0 }
                        },
                        status: 'unsolved', trials: 0, penalty: 0 
                    },
                    3: { 
                        sections: {
                            A: { status: 'unsolved', trials: 0 },
                            B: { status: 'unsolved', trials: 0 },
                            C: { status: 'unsolved', trials: 0 },
                            D: { status: 'unsolved', trials: 0 },
                            E: { status: 'unsolved', trials: 0 }
                        },
                        status: 'unsolved', trials: 0, penalty: 0 
                    },
                    4: { 
                        sections: {
                            A: { status: 'unsolved', trials: 0 },
                            B: { status: 'unsolved', trials: 0 },
                            C: { status: 'unsolved', trials: 0 },
                            D: { status: 'unsolved', trials: 0 },
                            E: { status: 'unsolved', trials: 0 }
                        },
                        status: 'unsolved', trials: 0, penalty: 0 
                    }
                },
                totalScore: 0,
                totalPenalty: 0,
                totalTrials: 0
            });
        }

        console.log('✅ Sample data initialized');
        if (!process.env.DEV_TEAM_PASSWORD) console.warn('Set DEV_TEAM_PASSWORD to log in to development fallback teams.');
    }
}

export default InMemoryStorage;
