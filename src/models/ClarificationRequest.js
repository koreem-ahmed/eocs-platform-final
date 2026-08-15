import mongoose from 'mongoose';

const clarificationRequestSchema = new mongoose.Schema({
    teamId: {
        type: String,
        required: true,
        trim: true,
        uppercase: true
    },
    problemId: {
        type: Number,
        required: true,
        min: 1,
        max: 20
    },
    question: {
        type: String,
        required: true,
        trim: true
    },
    status: {
        type: String,
        enum: ['pending', 'answered', 'rejected'],
        default: 'pending'
    },
    answer: {
        type: String,
        default: ''
    },
    isPublic: {
        type: Boolean,
        default: false
    },
    submittedAt: {
        type: Date,
        default: Date.now
    },
    answeredAt: {
        type: Date,
        default: null
    }
});

clarificationRequestSchema.index({ status: 1, isPublic: 1, answeredAt: -1 });
clarificationRequestSchema.index({ teamId: 1, status: 1, answeredAt: -1 });

export default mongoose.model('ClarificationRequest', clarificationRequestSchema);
