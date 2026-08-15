import mongoose from 'mongoose';
import { DEFAULT_PENALTY_MINUTES, DEFAULT_SUBTASK_POINTS, resolveSubtaskPoints } from '../config/scoring.js';

export const POINTS_PER_SECTION = DEFAULT_SUBTASK_POINTS;

const sectionScoreSchema = new mongoose.Schema({
    status: { type: String, enum: ['correct', 'wrong', 'unsolved'], default: 'unsolved' },
    score: { type: Number, default: 0, min: 0 },
    maxPoints: { type: Number, default: DEFAULT_SUBTASK_POINTS, min: 0 },
    trials: { type: Number, default: 0, min: 0 },
    firstSolvedTime: { type: Date, default: null },
    penalty: { type: Number, default: 0, min: 0 }
}, { _id: false });

const problemScoreSchema = new mongoose.Schema({
    totalScore: { type: Number, default: 0, min: 0 },
    status: { type: String, enum: ['correct', 'wrong', 'unsolved', 'partial'], default: 'unsolved' },
    sections: { type: Map, of: sectionScoreSchema, default: () => new Map() }
}, { _id: false });

const ScoreSchema = new mongoose.Schema({
    teamId: { type: String, required: true, unique: true, trim: true, uppercase: true },
    totalScore: { type: Number, default: 0, min: 0 },
    totalPenalty: { type: Number, default: 0, min: 0 },
    totalTrials: { type: Number, default: 0, min: 0 },
    problems: { type: Map, of: problemScoreSchema, default: () => new Map() },
    lastUpdated: { type: Date, default: Date.now }
});

ScoreSchema.index({ totalScore: -1, totalPenalty: 1 });

ScoreSchema.pre('save', function() {
    this.lastUpdated = new Date();
});

ScoreSchema.methods.ensureSection = function(problemId, sectionId, maxPoints = DEFAULT_SUBTASK_POINTS) {
    const problemKey = String(problemId);
    const sectionKey = String(sectionId);
    if (!this.problems.has(problemKey)) {
        this.problems.set(problemKey, { totalScore: 0, status: 'unsolved', sections: new Map() });
    }
    const problem = this.problems.get(problemKey);
    if (!problem.sections.has(sectionKey)) {
        problem.sections.set(sectionKey, {
            status: 'unsolved', score: 0, maxPoints: resolveSubtaskPoints(maxPoints), trials: 0, firstSolvedTime: null, penalty: 0
        });
    }
    return { problem, section: problem.sections.get(sectionKey) };
};

ScoreSchema.methods.recalculateTotals = function() {
    this.totalScore = 0;
    this.totalPenalty = 0;
    this.totalTrials = 0;
    for (const problem of this.problems.values()) {
        let correctCount = 0;
        let wrongCount = 0;
        let problemTotal = 0;
        for (const section of problem.sections.values()) {
            problemTotal += section.score || 0;
            this.totalPenalty += section.penalty || 0;
            this.totalTrials += section.trials || 0;
            if (section.status === 'correct') correctCount += 1;
            if (section.status === 'wrong') wrongCount += 1;
        }
        problem.totalScore = problemTotal;
        if (problem.sections.size > 0 && correctCount === problem.sections.size) problem.status = 'correct';
        else if (problem.sections.size > 0 && wrongCount === problem.sections.size) problem.status = 'wrong';
        else if (correctCount > 0 || wrongCount > 0) problem.status = 'partial';
        else problem.status = 'unsolved';
        this.totalScore += problemTotal;
    }
    this.markModified('problems');
    return this;
};

ScoreSchema.methods.recordSubmissionAttempt = function(problemId, sectionId) {
    const { section } = this.ensureSection(problemId, sectionId);
    section.trials += 1;
    return this.recalculateTotals();
};

ScoreSchema.methods.applyReview = function(problemId, sectionId, decision, wrongPenaltyMinutes = DEFAULT_PENALTY_MINUTES) {
    if (!['correct', 'wrong'].includes(decision)) throw new Error('Review decision must be correct or wrong');
    const { section } = this.ensureSection(problemId, sectionId);
    if (decision === 'correct') {
        section.status = 'correct';
        section.score = resolveSubtaskPoints(section.maxPoints);
        section.firstSolvedTime ||= new Date();
    } else if (section.status !== 'correct') {
        section.status = 'wrong';
        section.score = 0;
        section.penalty += wrongPenaltyMinutes;
    }
    return this.recalculateTotals();
};

ScoreSchema.methods.updateSection = function(problemId, sectionId, status) {
    if (!['correct', 'wrong', 'unsolved'].includes(status)) throw new Error('Invalid section status');
    const { section } = this.ensureSection(problemId, sectionId);
    section.status = status;
    section.score = status === 'correct' ? resolveSubtaskPoints(section.maxPoints) : 0;
    if (status === 'correct') section.firstSolvedTime ||= new Date();
    if (status === 'unsolved') section.firstSolvedTime = null;
    return this.recalculateTotals();
};

ScoreSchema.methods.updateProblem = function(problemId, status) {
    const problem = this.problems.get(String(problemId));
    if (!problem) throw new Error('Problem not found in score record');
    for (const sectionKey of problem.sections.keys()) this.updateSection(problemId, sectionKey, status);
    return this.recalculateTotals();
};

ScoreSchema.methods.incrementSectionTrials = ScoreSchema.methods.recordSubmissionAttempt;
ScoreSchema.methods.updateSectionScore = ScoreSchema.methods.applyReview;

export default mongoose.model('Score', ScoreSchema);
