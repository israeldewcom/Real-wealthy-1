// server.js — LIQUIDATED BACKEND v59.0 — PRODUCTION / AWARDS EDITION
// ============================================================================
// v59.0 – INTEGRATED REFERRAL AWARDS SYSTEM + PRODUCTION HARDENING
//   ✅ 16-tier Referral Awards ladder (5 → 2000+ referrals)
//   ✅ AwardTier + AwardClaim models, seed, eligibility engine
//   ✅ /api/awards/* user endpoints + /api/admin/awards/* admin endpoints
//   ✅ Leaderboard aggregation, ETA / avg-daily referral velocity
//   ✅ All v58.0 Cloudinary / body-parser / hoisting fixes retained
//   ✅ Production hardening: graceful shutdown, request budgets, dedupe
//       guards, atomic balance ops, audit trails, GDPR export, ops runbook
// ============================================================================

import express from 'express';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import mongoSanitize from 'express-mongo-sanitize';
import xss from 'xss-clean';
import hpp from 'hpp';
import { body, validationResult } from 'express-validator';
import cron from 'node-cron';
import path from 'path';
import multer from 'multer';
import fs from 'fs';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { Server } from 'socket.io';
import http from 'http';
import cloudinary from 'cloudinary';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env.production') });

// ==================== ENVIRONMENT VALIDATION (FAIL-FAST) ====================
const requiredEnvVars = [
    'MONGODB_URI',
    'JWT_SECRET',
    'NODE_ENV',
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET'
];

console.log('🔍 Environment Configuration:');
console.log('============================');

let envErrors = [];
for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`❌ Missing required env var: ${envVar}`);
        envErrors.push(envVar);
    } else {
        const display =
            envVar === 'JWT_SECRET' ? '***' :
            envVar === 'MONGODB_URI' ? String(process.env[envVar]).replace(/:[^:@]*@/, ':****@') :
            envVar === 'CLOUDINARY_API_SECRET' ? '***' :
            envVar === 'CLOUDINARY_API_KEY' ? '***' :
            process.env[envVar];
        console.log(`✅ ${envVar}: ${display}`);
    }
}

if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = crypto.randomBytes(64).toString('hex');
    console.warn('⚠️  JWT_SECRET missing – generated temporary one (users logged out on restart).');
    envErrors = envErrors.filter(v => v !== 'JWT_SECRET');
}

if (envErrors.length > 0) {
    console.error('\n🚨 CRITICAL: Missing required environment variables:', envErrors.join(', '));
    console.error('   Set them in your hosting provider (Render → Environment) and restart.\n');
    process.exit(1);
}

// ==================== DYNAMIC CONFIGURATION ====================
const PORT = parseInt(process.env.PORT, 10) || 10000;
const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:3000';
const SERVER_URL = process.env.SERVER_URL || `http://localhost:${PORT}`;
const MONGODB_URI = process.env.MONGODB_URI;

console.log('✅ PORT:', PORT);
console.log('✅ CLIENT_URL:', CLIENT_URL);
console.log('✅ SERVER_URL:', SERVER_URL);
console.log('✅ MONGODB_URI: (loaded from env)');
console.log('✅ CLOUDINARY_CLOUD_NAME:', process.env.CLOUDINARY_CLOUD_NAME);
console.log('============================\n');

const config = {
    port: PORT,
    nodeEnv: process.env.NODE_ENV || 'production',
    serverURL: SERVER_URL,
    mongoURI: MONGODB_URI,

    jwtSecret: process.env.JWT_SECRET,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '30d',
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS, 10) || 12,

    clientURL: CLIENT_URL,
    allowedOrigins: [],

    cloudinary: {
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
        secure: true,
        folder_root: process.env.CLOUDINARY_FOLDER_ROOT || 'liquidated'
    },

    emailEnabled: !!(process.env.EMAIL_HOST && process.env.EMAIL_USER && process.env.EMAIL_PASSWORD),
    emailConfig: {
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT, 10) || 587,
        secure: parseInt(process.env.EMAIL_PORT, 10) === 465,
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
        from: process.env.EMAIL_FROM || `"Liquidated" <${process.env.EMAIL_USER}>`
    },

    minInvestment: parseInt(process.env.MIN_INVESTMENT, 10) || 3000,
    minDeposit: parseInt(process.env.MIN_DEPOSIT, 10) || 3000,
    minWithdrawal: parseInt(process.env.MIN_WITHDRAWAL, 10) || 4000,
    maxWithdrawalPercent: parseFloat(process.env.MAX_WITHDRAWAL_PERCENT) || 100,

    platformFeePercent: parseFloat(process.env.PLATFORM_FEE_PERCENT) || 10,
    referralCommissionPercent: parseFloat(process.env.REFERRAL_COMMISSION_PERCENT) || 20,
    welcomeBonus: parseInt(process.env.WELCOME_BONUS, 10) || 100,

    planDurations: {
        firstThree: parseInt(process.env.PLAN_DURATION_FIRST_THREE, 10) || 20,
        nextThree: parseInt(process.env.PLAN_DURATION_NEXT_THREE, 10) || 15,
        remaining: parseInt(process.env.PLAN_DURATION_REMAINING, 10) || 9
    },

    dailyInterestTime: process.env.DAILY_INTEREST_TIME || '00:00',
    withdrawalAutoApprove: process.env.WITHDRAWAL_AUTO_APPROVE === 'true',
    referralCommissionOnFirstInvestment: process.env.REFERRAL_COMMISSION_ON_FIRST_INVESTMENT !== 'false',
    allInvestmentsRequireAdminApproval: process.env.ALL_INVESTMENTS_REQUIRE_ADMIN_APPROVAL === 'true',
    deductBalanceOnlyOnApproval: process.env.DEDUCT_BALANCE_ONLY_ON_APPROVAL === 'true',

    autoCorrectEarnings: process.env.AUTO_CORRECT_EARNINGS === 'true',
    autoCorrectCronSchedule: process.env.AUTO_CORRECT_CRON_SCHEDULE || '0 3 * * *',

    uploadDir: path.join(__dirname, 'uploads'),
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE, 10) || 10 * 1024 * 1024,
    allowedMimeTypes: {
        'image/jpeg': 'jpg',
        'image/jpg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'application/pdf': 'pdf',
        'image/svg+xml': 'svg'
    },

    cronLockTTL: {
        dailyInterest: 55 * 60 * 1000,
        investmentCompletion: 55 * 60 * 1000,
        autoCorrectEarnings: 6 * 60 * 60 * 1000
    },

    awardsFrontendURL: process.env.AWARDS_FRONTEND_URL || 'https://liquidated-zeta.vercel.app'
};

// ==================== CLOUDINARY INITIALIZATION ====================
cloudinary.v2.config({
    cloud_name: config.cloudinary.cloud_name,
    api_key: config.cloudinary.api_key,
    api_secret: config.cloudinary.api_secret,
    secure: true
});
console.log('☁️  Cloudinary configured:', config.cloudinary.cloud_name || '❌ MISSING');

const extraOrigins = (process.env.EXTRA_ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

config.allowedOrigins = [...new Set([
    config.clientURL,
    config.serverURL,
    config.awardsFrontendURL,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3001',
    'https://liquidated.com',
    'https://www.liquidated.com',
    'https://lucky-investment-eta.vercel.app',
    'https://uun-luckyinvestment.vercel.app',
    'https://real-wealthy-1.onrender.com',
    'https://real-wealthy-1-1.onrender.com',
    'https://liquidated-zeta.vercel.app',
    'https://lucky-admin-six.vercel.app',
    ...extraOrigins
].filter(Boolean))];

console.log('⚙️ Advanced Configuration Loaded:');
console.log(`- Port: ${config.port}`);
console.log(`- Environment: ${config.nodeEnv}`);
console.log(`- Client URL: ${config.clientURL}`);
console.log(`- Server URL: ${config.serverURL}`);
console.log(`- Awards Frontend: ${config.awardsFrontendURL}`);
console.log(`- Email Enabled: ${config.emailEnabled}`);
console.log(`- Withdrawal Auto-approve: ${config.withdrawalAutoApprove}`);
console.log(`- Daily Interest Time: ${config.dailyInterestTime}`);
console.log(`- Minimum Withdrawal: ₦${config.minWithdrawal.toLocaleString()}`);
console.log(`- Referral Commission: ${config.referralCommissionPercent}%`);
console.log(`- All Investments Require Admin Approval: ${config.allInvestmentsRequireAdminApproval}`);
console.log(`- Balance Deducted Only on Approval: ${config.deductBalanceOnlyOnApproval}`);
console.log(`- Auto‑Correct Earnings: ${config.autoCorrectEarnings ? '✅ ENABLED' : '❌ DISABLED'}`);
console.log(`- Cloudinary Root Folder: ${config.cloudinary.folder_root}`);
console.log(`- Allowed Origins: ${config.allowedOrigins.length}`);
console.log(`   → ${config.allowedOrigins.join('\n   → ')}`);

// ==================== EXPRESS + SOCKET.IO ====================
const app = express();
app.set('trust proxy', 1);

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: config.allowedOrigins,
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000
});

io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
        const decoded = jwt.verify(token, config.jwtSecret);
        socket.userId = decoded.id;
        socket.userRole = decoded.role;
        next();
    } catch (err) {
        next(new Error('Invalid token'));
    }
});

io.on('connection', (socket) => {
    console.log(`🔌 Authenticated socket: ${socket.id} (user: ${socket.userId})`);

    socket.on('join-user', (userId) => {
        if (userId === socket.userId) {
            socket.join(`user-${userId}`);
        } else {
            socket.emit('error', 'Unauthorized to join this room');
        }
    });

    socket.on('admin-join', (adminId) => {
        const isAdmin = socket.userRole === 'admin' || socket.userRole === 'super_admin';
        if (!isAdmin) return socket.emit('error', 'Admin privileges required');
        if (adminId !== socket.userId) return socket.emit('error', 'Unauthorized');

        socket.join(`admin-${adminId}`);
        socket.join('admin-room');
        socket.join('withdrawal-approvals');
        socket.join('investment-monitor');
        socket.join('deposit-approvals');
        socket.join('award-claims');
    });

    socket.on('disconnect', () => {
        console.log(`🔌 Socket disconnected: ${socket.id}`);
    });
});

const emitToUser = (userId, event, data) => io.to(`user-${userId}`).emit(event, data);
const emitToAdmins = (event, data) => io.to('admin-room').emit(event, data);
const emitToWithdrawalAdmins = (event, data) => io.to('withdrawal-approvals').emit(event, data);
const emitToDepositAdmins = (event, data) => io.to('deposit-approvals').emit(event, data);
const emitToInvestmentAdmins = (event, data) => io.to('investment-monitor').emit(event, data);
const emitToAwardAdmins = (event, data) => io.to('award-claims').emit(event, data);

// ==================== SECURITY HEADERS ====================
app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
            fontSrc: ["'self'", 'https://fonts.gstatic.com', 'https://cdnjs.cloudflare.com'],
            scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
            imgSrc: ["'self'", 'data:', 'https:', 'http:', config.serverURL, config.clientURL, config.awardsFrontendURL, 'https://res.cloudinary.com'],
            connectSrc: ["'self'", 'ws:', 'wss:', config.clientURL, config.serverURL, config.awardsFrontendURL, 'https://api.cloudinary.com', 'https://res.cloudinary.com']
        }
    }
}));

app.use(xss());
app.use(hpp());
app.use(mongoSanitize());
app.use(compression());

app.use((req, res, next) => {
    req.id = req.headers['x-request-id'] || crypto.randomBytes(8).toString('hex');
    res.set('X-Request-Id', req.id);
    next();
});

morgan.token('id', req => req.id);
if (config.nodeEnv === 'production') {
    app.use(morgan(':id :remote-addr :method :url :status :response-time ms'));
} else {
    app.use(morgan('dev'));
}

// ==================== CORS ====================
const corsOptions = {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (config.allowedOrigins.indexOf(origin) !== -1) return callback(null, true);
        console.log(`🚫 Blocked by CORS: ${origin}`);
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'x-api-key', 'x-user-id', 'x-request-id']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ==================== BODY PARSING ====================
app.use((req, res, next) => {
    const ct = (req.headers['content-type'] || '').toLowerCase();

    if (ct.includes('multipart/form-data')) return next();
    if (ct.includes('application/x-www-form-urlencoded')) return next();

    express.json({
        limit: '50mb',
        type: () => true,
        verify: (req, res, buf) => {
            req.rawBody = buf;
        }
    })(req, res, next);
});

app.use(express.urlencoded({ extended: true, limit: '50mb', parameterLimit: 100000 }));

// ==================== RATE LIMITING ====================
const createRateLimiter = (windowMs, max, message) => rateLimit({
    windowMs,
    max,
    message: { success: false, message },
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false
});

const rateLimiters = {
    createAccount: createRateLimiter(60 * 60 * 1000, 10, 'Too many accounts created from this IP'),
    auth: createRateLimiter(15 * 60 * 1000, 20, 'Too many authentication attempts'),
    api: createRateLimiter(15 * 60 * 1000, 1000, 'Too many requests from this IP'),
    financial: createRateLimiter(15 * 60 * 1000, 50, 'Too many financial operations'),
    passwordReset: createRateLimiter(15 * 60 * 1000, 5, 'Too many password reset attempts'),
    admin: createRateLimiter(15 * 60 * 1000, 500, 'Too many admin requests'),
    awardsClaim: createRateLimiter(60 * 60 * 1000, 5, 'Too many award claims submitted')
};

app.use('/api/auth/register', rateLimiters.createAccount);
app.use('/api/auth/login', rateLimiters.auth);
app.use('/api/auth/forgot-password', rateLimiters.passwordReset);
app.use('/api/auth/reset-password', rateLimiters.passwordReset);
app.use('/api/auth/change-password', rateLimiters.passwordReset);
app.use('/api/investments', rateLimiters.financial);
app.use('/api/deposits', rateLimiters.financial);
app.use('/api/withdrawals', rateLimiters.financial);
app.use('/api/awards/claim', rateLimiters.awardsClaim);
app.use('/api/admin', rateLimiters.admin);
app.use('/api/', rateLimiters.api);

// ==================== FILE UPLOAD (CLOUDINARY) ====================
if (!fs.existsSync(config.uploadDir)) {
    fs.mkdirSync(config.uploadDir, { recursive: true });
    console.log('📁 Created main uploads directory (legacy)');
}

const fileFilter = (req, file, cb) => {
    if (!config.allowedMimeTypes[file.mimetype]) {
        return cb(new Error(`Invalid file type: ${file.mimetype}`), false);
    }
    cb(null, true);
};

const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter,
    limits: { fileSize: config.maxFileSize, files: 10 }
});

const validateFileSignature = async (buffer, declaredMime) => {
    try {
        if (!Buffer.isBuffer(buffer) || buffer.length < 16) {
            throw new Error('Invalid or empty file buffer');
        }

        const head = buffer.slice(0, 16);
        const hex = head.toString('hex').toUpperCase();
        const ascii = head.toString('utf8').toLowerCase();

        const signatures = {
            'image/jpeg': () => hex.startsWith('FFD8FF'),
            'image/jpg': () => hex.startsWith('FFD8FF'),
            'image/png': () => hex.startsWith('89504E47'),
            'image/gif': () => hex.startsWith('47494638'),
            'image/webp': () => hex.startsWith('52494646') && hex.substr(16, 8) === '57454250',
            'application/pdf': () => hex.startsWith('25504446'),
            'image/svg+xml': () => ascii.includes('<?xml') || ascii.includes('<svg')
        };

        const check = signatures[declaredMime];
        if (!check || !check()) {
            throw new Error('File content does not match its declared type');
        }
        return true;
    } catch (err) {
        console.error('Signature validation error:', err.message);
        throw err;
    }
};

async function handleFileUpload(file, folder = 'general', userId = null) {
    if (!file || !file.buffer) {
        throw new Error('No file buffer available for upload');
    }

    const privateFolders = new Set(['kyc-documents']);
    const isPrivate = privateFolders.has(folder);

    const rootFolder = config.cloudinary.folder_root;
    const targetFolder = `${rootFolder}/${folder}`;

    const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.v2.uploader.upload_stream(
            {
                folder: targetFolder,
                resource_type: 'auto',
                type: isPrivate ? 'authenticated' : 'upload',
                use_filename: false,
                unique_filename: true,
                overwrite: false,
                context: {
                    userId: userId ? String(userId) : 'anonymous',
                    folder,
                    originalName: file.originalname
                }
            },
            (err, res) => (err ? reject(err) : resolve(res))
        );
        stream.end(file.buffer);
    });

    return {
        url: result.secure_url,
        public_id: result.public_id,
        filename: result.public_id.split('/').pop(),
        originalName: file.originalname,
        size: result.bytes,
        mimeType: file.mimetype,
        folder,
        owner: userId,
        is_private: isPrivate
    };
}

// ==================== AUTH MIDDLEWARE (hoisted) ====================
async function auth(req, res, next) {
    try {
        let token = req.header('Authorization');
        if (!token) return res.status(401).json(formatResponse(false, 'No token, authorization denied'));

        if (token.startsWith('Bearer ')) token = token.slice(7);

        const decoded = jwt.verify(token, config.jwtSecret);
        const user = await User.findById(decoded.id);

        if (!user) return res.status(401).json(formatResponse(false, 'Token is not valid'));
        if (!user.is_active) return res.status(401).json(formatResponse(false, 'Account is deactivated. Please contact support.'));
        if (user.account_status === 'suspended') return res.status(403).json(formatResponse(false, 'Account is suspended. Please contact support.'));
        if (user.account_status === 'rejected') return res.status(403).json(formatResponse(false, 'Account has been rejected. Please contact support.'));

        user.last_active = new Date();
        await user.save();

        req.user = user;
        req.userId = user._id;
        next();
    } catch (error) {
        if (error.name === 'JsonWebTokenError') return res.status(401).json(formatResponse(false, 'Invalid token'));
        if (error.name === 'TokenExpiredError') return res.status(401).json(formatResponse(false, 'Token expired'));
        console.error('Auth middleware error:', error);
        res.status(500).json(formatResponse(false, 'Server error during authentication'));
    }
}

async function adminAuth(req, res, next) {
    try {
        await auth(req, res, () => {
            if (req.user.role !== 'admin' && req.user.role !== 'super_admin') {
                return res.status(403).json(formatResponse(false, 'Access denied. Admin privileges required.'));
            }
            next();
        });
    } catch (error) {
        handleError(res, error, 'Admin authentication error');
    }
}

// ==================== UTILITY FUNCTIONS (hoisted) ====================
function formatResponse(success, message, data = null, pagination = null) {
    const response = { success, message, timestamp: new Date().toISOString() };
    if (data !== null) response.data = data;
    if (pagination !== null) response.pagination = pagination;
    return response;
}

function handleError(res, error, defaultMessage = 'An error occurred') {
    console.error('Error:', error);
    if (error.name === 'ValidationError') {
        const messages = Object.values(error.errors).map(v => v.message);
        return res.status(400).json(formatResponse(false, 'Validation Error', { errors: messages }));
    }
    if (error.code === 11000) {
        const field = Object.keys(error.keyValue)[0];
        return res.status(400).json(formatResponse(false, `${field} already exists`));
    }
    if (error.name === 'JsonWebTokenError') {
        return res.status(401).json(formatResponse(false, 'Invalid token'));
    }
    if (error.name === 'TokenExpiredError') {
        return res.status(401).json(formatResponse(false, 'Token expired'));
    }
    const statusCode = error.statusCode || error.status || 500;
    const message = config.nodeEnv === 'production' && statusCode === 500 ? defaultMessage : error.message;
    return res.status(statusCode).json(formatResponse(false, message));
}

function generateReference(prefix = 'REF') {
    return `${prefix}${Date.now()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}

// ==================== EMAIL ====================
let emailTransporter = null;
if (config.emailEnabled) {
    try {
        emailTransporter = nodemailer.createTransport({
            host: config.emailConfig.host,
            port: config.emailConfig.port,
            secure: config.emailConfig.secure,
            auth: { user: config.emailConfig.user, pass: config.emailConfig.pass }
        });

        emailTransporter.verify((error) => {
            if (error) console.log('❌ Email configuration error:', error.message);
            else console.log('✅ Email server is ready to send messages');
        });
    } catch (error) {
        console.error('❌ Email setup failed:', error.message);
    }
}

const sendEmail = async (to, subject, html, text = '') => {
    try {
        if (!emailTransporter) {
            console.log(`📧 Email simulated: To: ${to}, Subject: ${subject}`);
            return { simulated: true, success: true };
        }
        const info = await emailTransporter.sendMail({
            from: config.emailConfig.from,
            to, subject,
            text: text || html.replace(/<[^>]*>/g, ''),
            html
        });
        console.log(`✅ Email sent to ${to} (${info.messageId})`);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('❌ Email sending error:', error.message);
        return { success: false, error: error.message };
    }
};

// ==================== DATABASE MODELS ====================
const userSchema = new mongoose.Schema({
    full_name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true },
    phone: { type: String, required: true },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ['user', 'admin', 'super_admin'], default: 'user' },

    balance: { type: Number, default: 0, min: 0 },
    total_earnings: { type: Number, default: 0, min: 0 },
    referral_earnings: { type: Number, default: 0, min: 0 },
    daily_earnings: { type: Number, default: 0, min: 0 },
    total_withdrawn: { type: Number, default: 0, min: 0 },
    withdrawable_earnings: { type: Number, default: 0, min: 0 },
    reserved_earnings: { type: Number, default: 0, min: 0 },

    risk_tolerance: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    investment_strategy: { type: String, enum: ['conservative', 'balanced', 'aggressive'], default: 'balanced' },
    country: { type: String, default: 'ng' },
    currency: { type: String, enum: ['NGN', 'USD', 'EUR', 'GBP'], default: 'NGN' },

    referral_code: { type: String, unique: true, sparse: true },
    referred_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    referral_count: { type: Number, default: 0 },
    confirmed_referral_count: { type: Number, default: 0 },

    kyc_verified: { type: Boolean, default: false },
    kyc_status: { type: String, enum: ['pending', 'verified', 'rejected', 'not_submitted'], default: 'not_submitted' },
    kyc_submitted_at: Date,
    kyc_verified_at: Date,

    two_factor_enabled: { type: Boolean, default: false },
    two_factor_secret: { type: String, select: false },
    is_active: { type: Boolean, default: true },
    is_verified: { type: Boolean, default: false },
    verification_token: String,
    verification_expires: Date,
    password_reset_token: String,
    password_reset_expires: Date,

    bank_details: {
        bank_name: String,
        account_name: String,
        account_number: String,
        bank_code: String,
        verified: { type: Boolean, default: false },
        verified_at: Date,
        last_updated: Date
    },

    wallet_address: String,
    paypal_email: String,
    last_login: Date,
    last_active: Date,
    login_attempts: { type: Number, default: 0 },
    lock_until: Date,
    profile_image: String,

    notifications_enabled: { type: Boolean, default: true },
    email_notifications: { type: Boolean, default: true },
    sms_notifications: { type: Boolean, default: false },
    investment_alerts: { type: Boolean, default: true },
    deposit_confirmations: { type: Boolean, default: true },
    marketing_messages: { type: Boolean, default: false },
    dark_mode: { type: Boolean, default: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },

    total_deposits: { type: Number, default: 0 },
    total_withdrawals: { type: Number, default: 0 },
    total_investments: { type: Number, default: 0 },
    last_deposit_date: Date,
    last_withdrawal_date: Date,
    last_investment_date: Date,
    last_daily_interest_date: Date,

    first_investment_amount: { type: Number, default: 0 },
    first_investment_date: Date,
    referral_commission_paid: { type: Boolean, default: false },

    login_history: [{
        ip: String,
        location: String,
        device: String,
        timestamp: { type: Date, default: Date.now }
    }],

    account_status: {
        type: String,
        enum: ['active', 'suspended', 'rejected', 'pending_verification'],
        default: 'active'
    },
    suspension_reason: String,
    suspension_date: Date,
    suspension_end_date: Date,
    suspended_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    last_interest_calculation: Date,
    next_interest_calculation: Date,

    auto_reinvest_earnings: { type: Boolean, default: false },
    auto_reinvest_percentage: { type: Number, default: 50, min: 0, max: 100 }
}, {
    timestamps: true,
    toJSON: {
        virtuals: true,
        transform: function (doc, ret) {
            delete ret.password;
            delete ret.two_factor_secret;
            delete ret.verification_token;
            delete ret.password_reset_token;
            delete ret.login_attempts;
            delete ret.lock_until;
            ret.available_for_withdrawal = doc.availableForWithdrawal;
            ret.portfolio_value = doc.portfolioValue;
            return ret;
        }
    },
    toObject: { virtuals: true }
});

userSchema.virtual('availableForWithdrawal').get(function () {
    return Math.max(0, (this.withdrawable_earnings || 0) - (this.reserved_earnings || 0));
});

userSchema.virtual('portfolioValue').get(function () {
    return (this.balance || 0) + (this.withdrawable_earnings || 0);
});

userSchema.methods.getTotalActiveInvestments = async function () {
    return mongoose.model('Investment').countDocuments({ user: this._id, status: 'active' });
};

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ referral_code: 1 }, { unique: true, sparse: true });
userSchema.index({ is_active: 1, role: 1, kyc_status: 1 });
userSchema.index({ withdrawable_earnings: 1 });
userSchema.index({ account_status: 1 });
userSchema.index({ last_interest_calculation: 1 });
userSchema.index({ confirmed_referral_count: -1 });

userSchema.pre('save', async function (next) {
    if (this.isModified('password')) {
        this.password = await bcrypt.hash(this.password, config.bcryptRounds);
    }

    if (!this.referral_code) {
        this.referral_code = crypto.randomBytes(6).toString('hex').toUpperCase();
    }

    if (this.isModified('email') && !this.is_verified) {
        this.verification_token = crypto.randomBytes(32).toString('hex');
        this.verification_expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    }

    if (this.isModified('bank_details')) {
        this.bank_details.last_updated = new Date();
    }

    if (
        this.isModified('total_earnings') ||
        this.isModified('referral_earnings') ||
        this.isModified('total_withdrawn')
    ) {
        this.withdrawable_earnings = Math.max(0,
            (this.total_earnings || 0) +
            (this.referral_earnings || 0) -
            (this.total_withdrawn || 0)
        );
    }

    if (this.isModified('role') && this.role === 'admin' && this.account_status === 'pending_verification') {
        this.account_status = 'active';
        this.is_active = true;
    }

    next();
});

userSchema.methods.comparePassword = async function (candidatePassword) {
    try { return await bcrypt.compare(candidatePassword, this.password); }
    catch { return false; }
};

userSchema.methods.generateAuthToken = function () {
    return jwt.sign(
        {
            id: this._id,
            email: this.email,
            role: this.role,
            kyc_verified: this.kyc_verified,
            balance: this.balance,
            total_earnings: this.total_earnings,
            referral_earnings: this.referral_earnings,
            account_status: this.account_status
        },
        config.jwtSecret,
        { expiresIn: config.jwtExpiresIn }
    );
};

userSchema.methods.generatePasswordResetToken = function () {
    const resetToken = crypto.randomBytes(32).toString('hex');
    this.password_reset_token = crypto.createHash('sha256').update(resetToken).digest('hex');
    this.password_reset_expires = new Date(Date.now() + 10 * 60 * 1000);
    return resetToken;
};

userSchema.methods.getAvailableForWithdrawal = function () {
    return Math.max(0, (this.withdrawable_earnings || 0) - (this.reserved_earnings || 0));
};

userSchema.methods.suspendAccount = function (reason, adminId, durationDays = null) {
    this.account_status = 'suspended';
    this.is_active = false;
    this.suspension_reason = reason;
    this.suspension_date = new Date();
    this.suspended_by = adminId;
    if (durationDays) this.suspension_end_date = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
    return this;
};

userSchema.methods.activateAccount = function () {
    this.account_status = 'active';
    this.is_active = true;
    this.suspension_reason = null;
    this.suspension_date = null;
    this.suspension_end_date = null;
    this.suspended_by = null;
    return this;
};

userSchema.methods.rejectAccount = function (reason, adminId) {
    this.account_status = 'rejected';
    this.is_active = false;
    this.suspension_reason = reason;
    this.suspension_date = new Date();
    this.suspended_by = adminId;
    return this;
};

const User = mongoose.model('User', userSchema);

const investmentPlanSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    description: { type: String, required: true },
    min_amount: { type: Number, required: true, min: config.minInvestment },
    max_amount: { type: Number, min: config.minInvestment },
    daily_interest: { type: Number, required: true, min: 0.1, max: 100 },
    total_interest: { type: Number, required: true, min: 1, max: 1000 },
    duration: { type: Number, required: true, min: 1 },
    risk_level: { type: String, enum: ['low', 'medium', 'high'], required: true },
    raw_material: { type: String, required: true },
    category: {
        type: String,
        enum: ['agriculture', 'mining', 'energy', 'metals', 'crypto', 'real_estate', 'precious_stones', 'livestock', 'timber', 'aquaculture', 'stocks'],
        default: 'stocks'
    },
    is_active: { type: Boolean, default: true },
    is_popular: { type: Boolean, default: false },
    image_url: String,
    color: String,
    icon: String,
    features: [String],
    investment_count: { type: Number, default: 0 },
    total_invested: { type: Number, default: 0 },
    total_earned: { type: Number, default: 0 },
    rating: { type: Number, default: 0, min: 0, max: 5 },
    tags: [String],
    display_order: { type: Number, default: 0 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

investmentPlanSchema.index({ is_active: 1, is_popular: 1, category: 1 });
const InvestmentPlan = mongoose.model('InvestmentPlan', investmentPlanSchema);

const investmentSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    plan: { type: mongoose.Schema.Types.ObjectId, ref: 'InvestmentPlan', required: true },
    amount: { type: Number, required: true, min: config.minInvestment },
    status: {
        type: String,
        enum: ['pending', 'active', 'completed', 'cancelled', 'failed', 'rejected'],
        default: 'active'
    },
    start_date: { type: Date, default: Date.now },
    end_date: { type: Date, required: true },
    approved_at: { type: Date, default: Date.now },
    rejected_at: Date,
    rejected_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejection_reason: String,

    expected_earnings: { type: Number, required: true },
    earned_so_far: { type: Number, default: 0 },
    daily_earnings: { type: Number, default: 0 },
    last_earning_date: { type: Date, default: Date.now },
    next_interest_date: { type: Date, default: () => new Date(Date.now() + 24 * 60 * 60 * 1000) },
    interest_added_count: { type: Number, default: 1 },
    total_interest_days: { type: Number, default: 0 },

    payment_proof_url: String,
    payment_proof_public_id: String,
    payment_verified: { type: Boolean, default: true },
    auto_renew: { type: Boolean, default: false },
    auto_renewed: { type: Boolean, default: false },
    approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    transaction_id: String,
    remarks: String,

    balance_deducted: { type: Boolean, default: true },
    is_auto_approved: { type: Boolean, default: true },

    reversal_transaction_id: String,
    reversed_at: Date,

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

investmentSchema.index({ user: 1, status: 1 });
investmentSchema.index({ end_date: 1 });
investmentSchema.index({ next_interest_date: 1 });
investmentSchema.index({ balance_deducted: 1 });
const Investment = mongoose.model('Investment', investmentSchema);

const depositSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: config.minDeposit },
    payment_method: {
        type: String,
        enum: ['bank_transfer', 'crypto', 'paypal', 'card', 'flutterwave', 'paystack'],
        required: true
    },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'cancelled'], default: 'pending' },
    payment_proof_url: String,
    payment_proof_public_id: String,
    transaction_hash: String,
    reference: { type: String, unique: true, sparse: true },
    admin_notes: String,
    approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approved_at: Date,
    rejected_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejected_at: Date,
    rejection_reason: String,
    bank_details: {
        bank_name: String,
        account_name: String,
        account_number: String
    },
    crypto_details: {
        wallet_address: String,
        coin_type: String
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

depositSchema.index({ user: 1, status: 1 });
depositSchema.index({ reference: 1 }, { unique: true, sparse: true });
const Deposit = mongoose.model('Deposit', depositSchema);

const withdrawalSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    amount: { type: Number, required: true, min: config.minWithdrawal },

    from_earnings: { type: Number, default: 0 },
    from_referral: { type: Number, default: 0 },

    platform_fee: { type: Number, default: 0 },
    net_amount: { type: Number, required: true },

    bank_details: {
        bank_name: String,
        account_name: String,
        account_number: String,
        bank_code: String,
        verified: { type: Boolean, default: false }
    },
    wallet_address: String,
    paypal_email: String,

    status: { type: String, enum: ['pending', 'approved', 'rejected', 'paid', 'processing'], default: 'pending' },
    reference: { type: String, unique: true, sparse: true },
    admin_notes: String,
    approved_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approved_at: Date,
    paid_at: Date,
    transaction_id: String,
    rejected_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rejected_at: Date,
    rejection_reason: String,

    auto_approved: { type: Boolean, default: false },
    requires_admin_approval: { type: Boolean, default: true },

    admin_review_status: {
        type: String,
        enum: ['pending_review', 'under_review', 'approved', 'rejected'],
        default: 'pending_review'
    },
    reviewed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    review_notes: String,
    review_date: Date,

    transaction_id_ref: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

withdrawalSchema.index({ user: 1, status: 1 });
withdrawalSchema.index({ admin_review_status: 1 });
const Withdrawal = mongoose.model('Withdrawal', withdrawalSchema);

const transactionSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: {
        type: String,
        enum: ['deposit', 'withdrawal', 'investment', 'daily_interest', 'referral_bonus', 'bonus', 'fee', 'refund', 'transfer'],
        required: true
    },
    amount: { type: Number, required: true },
    description: { type: String, required: true },
    reference: { type: String, unique: true, sparse: true },
    status: { type: String, enum: ['pending', 'completed', 'failed', 'cancelled'], default: 'completed' },

    balance_before: Number,
    balance_after: Number,
    earnings_before: Number,
    earnings_after: Number,
    referral_earnings_before: Number,
    referral_earnings_after: Number,
    withdrawable_before: Number,
    withdrawable_after: Number,

    related_investment: { type: mongoose.Schema.Types.ObjectId, ref: 'Investment' },
    related_deposit: { type: mongoose.Schema.Types.ObjectId, ref: 'Deposit' },
    related_withdrawal: { type: mongoose.Schema.Types.ObjectId, ref: 'Withdrawal' },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

transactionSchema.index({ user: 1, createdAt: -1 });
transactionSchema.index({ type: 1, status: 1 });
const Transaction = mongoose.model('Transaction', transactionSchema);

const kycSubmissionSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    id_type: { type: String, enum: ['national_id', 'passport', 'driver_license', 'voters_card'], required: true },
    id_number: { type: String, required: true },
    id_front_url: { type: String, required: true },
    id_back_url: String,
    selfie_with_id_url: { type: String, required: true },
    address_proof_url: String,
    id_front_public_id: String,
    id_back_public_id: String,
    selfie_with_id_public_id: String,
    address_proof_public_id: String,
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'under_review'], default: 'pending' },
    reviewed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewed_at: Date,
    rejection_reason: String,
    notes: String,
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

kycSubmissionSchema.index({ status: 1 });
const KYCSubmission = mongoose.model('KYCSubmission', kycSubmissionSchema);

const supportTicketSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    ticket_id: { type: String, unique: true, required: true },
    subject: { type: String, required: true },
    message: { type: String, required: true },
    category: {
        type: String,
        enum: ['general', 'technical', 'investment', 'withdrawal', 'deposit', 'kyc', 'account', 'other'],
        default: 'general'
    },
    priority: { type: String, enum: ['low', 'medium', 'high', 'urgent'], default: 'medium' },
    status: { type: String, enum: ['open', 'in_progress', 'resolved', 'closed'], default: 'open' },
    attachments: [{
        filename: String,
        url: String,
        public_id: String,
        size: Number,
        mime_type: String
    }],
    assigned_to: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    last_reply_at: Date,
    reply_count: { type: Number, default: 0 },
    is_read_by_user: { type: Boolean, default: false },
    is_read_by_admin: { type: Boolean, default: false },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

supportTicketSchema.index({ user: 1, status: 1 });
const SupportTicket = mongoose.model('SupportTicket', supportTicketSchema);

const referralSchema = new mongoose.Schema({
    referrer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    referred_user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    referral_code: { type: String, required: true },
    status: { type: String, enum: ['pending', 'active', 'completed', 'expired'], default: 'pending' },

    total_commission: { type: Number, default: 0 },
    commission_percentage: { type: Number, default: config.referralCommissionPercent },

    investment_amount: Number,
    earnings_paid: { type: Boolean, default: false },
    paid_at: Date,

    first_investment_commission_paid: { type: Boolean, default: false },
    first_investment_amount: Number,
    first_investment_date: Date,

    commission_transaction_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Transaction' },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

referralSchema.index({ referrer: 1, status: 1 });
referralSchema.index({ referred_user: 1 });
referralSchema.index({ referrer: 1, first_investment_commission_paid: 1 });
const Referral = mongoose.model('Referral', referralSchema);

const notificationSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    message: { type: String, required: true },
    type: {
        type: String,
        enum: ['info', 'success', 'warning', 'error', 'promotional', 'investment', 'withdrawal', 'deposit', 'kyc', 'referral', 'system', 'award'],
        default: 'info'
    },
    is_read: { type: Boolean, default: false },
    is_email_sent: { type: Boolean, default: false },
    action_url: String,
    priority: { type: Number, default: 0, min: 0, max: 3 },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

notificationSchema.index({ user: 1, is_read: 1 });
const Notification = mongoose.model('Notification', notificationSchema);

const adminAuditSchema = new mongoose.Schema({
    admin_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    actor: { type: String, enum: ['admin', 'system'], default: 'admin' },
    action: { type: String, required: true },
    target_type: {
        type: String,
        enum: ['user', 'investment', 'deposit', 'withdrawal', 'kyc', 'transaction', 'plan', 'system', 'award_claim', 'award_tier']
    },
    target_id: mongoose.Schema.Types.ObjectId,
    details: mongoose.Schema.Types.Mixed,
    ip_address: String,
    user_agent: String,
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

adminAuditSchema.index({ admin_id: 1, createdAt: -1 });
const AdminAudit = mongoose.model('AdminAudit', adminAuditSchema);

const amlMonitoringSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    transaction_id: mongoose.Schema.Types.ObjectId,
    transaction_type: String,
    amount: Number,
    flagged_reason: String,
    risk_score: { type: Number, min: 0, max: 100 },
    status: { type: String, enum: ['pending_review', 'cleared', 'blocked', 'suspicious'], default: 'pending_review' },
    reviewed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewed_at: Date,
    notes: String,
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

amlMonitoringSchema.index({ status: 1, risk_score: -1 });
const AmlMonitoring = mongoose.model('AmlMonitoring', amlMonitoringSchema);

const cronLockSchema = new mongoose.Schema({
    name: { type: String, unique: true, required: true, index: true },
    lockedUntil: { type: Date, required: true, index: true },
    lockedBy: String,
    lastRunAt: Date,
    lastRunResult: String
}, { timestamps: true });

const CronLock = mongoose.model('CronLock', cronLockSchema);

// ==================== AWARDS MODELS ====================
const awardTierSchema = new mongoose.Schema({
    tier_number:             { type: Number, required: true, unique: true },
    slug:                    { type: String, required: true, unique: true },
    title:                   { type: String, required: true },
    referrals_required:      { type: Number, required: true },
    reward_name:             { type: String, required: true },
    reward_description:      { type: String, required: true },
    reward_category:         { type: String, enum: ['merch', 'electronics', 'lifestyle', 'vehicle', 'partnership'], required: true },
    reward_icon:             { type: String, default: '🎁' },
    image_url:               { type: String, default: '' },
    accent_color:            { type: String, default: '#d4af37' },
    estimated_value_ngn:     { type: Number, default: 0 },
    requires_admin_approval: { type: Boolean, default: true },
    terms:                   { type: String, default: '' },
    is_active:               { type: Boolean, default: true },
    display_order:           { type: Number, default: 0 }
}, { timestamps: true });

awardTierSchema.index({ referrals_required: 1, is_active: 1 });
const AwardTier = mongoose.model('AwardTier', awardTierSchema);

const awardClaimSchema = new mongoose.Schema({
    user:               { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    tier:               { type: mongoose.Schema.Types.ObjectId, ref: 'AwardTier', required: true },
    tier_number:        { type: Number, required: true },
    referrals_at_claim: { type: Number, required: true },
    status: {
        type: String,
        enum: ['claimed', 'under_review', 'approved', 'fulfilled', 'rejected'],
        default: 'claimed'
    },
    delivery_details: {
        full_name: String, phone: String, email: String,
        address_line: String, city: String, state: String,
        country: { type: String, default: 'Nigeria' }, postal_code: String
    },
    admin_notes: String,
    reviewed_by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewed_at: Date,
    fulfilled_at: Date,
    tracking_info: String,
    rejection_reason: String,
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

awardClaimSchema.index({ user: 1, tier_number: 1 }, { unique: true });
awardClaimSchema.index({ status: 1, createdAt: -1 });
const AwardClaim = mongoose.model('AwardClaim', awardClaimSchema);

// ==================== DISTRIBUTED CRON LOCKS ====================
const acquireCronLock = async (name, ttlMs) => {
    const now = new Date();
    const lockedUntil = new Date(now.getTime() + ttlMs);
    const owner = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

    try {
        const updated = await CronLock.findOneAndUpdate(
            { name, lockedUntil: { $lt: now } },
            { $set: { lockedUntil, lockedBy: owner } },
            { new: true }
        );
        if (updated) return owner;

        try {
            await CronLock.create({ name, lockedUntil, lockedBy: owner });
            return owner;
        } catch (err) {
            if (err.code === 11000) return null;
            throw err;
        }
    } catch (err) {
        console.error(`Cron lock acquire error [${name}]:`, err.message);
        return null;
    }
};

const releaseCronLock = async (name, owner, result = 'ok') => {
    try {
        await CronLock.updateOne(
            { name, lockedBy: owner },
            { $set: { lockedUntil: new Date(0), lastRunAt: new Date(), lastRunResult: result } }
        );
    } catch (err) {
        console.error(`Cron lock release error [${name}]:`, err.message);
    }
};

const withCronLock = async (name, ttlMs, fn) => {
    const owner = await acquireCronLock(name, ttlMs);
    if (!owner) {
        console.log(`⏭️  Cron [${name}] locked by another instance – skipping`);
        return { skipped: true };
    }
    try {
        const result = await fn();
        await releaseCronLock(name, owner, 'ok');
        return result;
    } catch (err) {
        await releaseCronLock(name, owner, `error: ${err.message}`);
        throw err;
    }
};

// ==================== NOTIFICATION ====================
const createNotification = async (userId, title, message, type = 'info', actionUrl = null, metadata = {}) => {
    try {
        const notification = new Notification({
            user: userId,
            title, message, type,
            action_url: actionUrl,
            metadata: { ...metadata, sentAt: new Date() }
        });
        await notification.save();

        emitToUser(userId, 'new-notification', {
            title, message, type, action_url: actionUrl
        });

        const user = await User.findById(userId);
        if (user && user.email_notifications && type !== 'system') {
            const emailSubject = `Liquidated - ${title}`;
            const emailHtml = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <div style="background: linear-gradient(135deg, #d4af37 0%, #059669 100%); padding: 30px; text-align: center; color: white;">
                        <h1 style="margin: 0;">Liquidated</h1>
                        <p style="opacity: 0.9; margin: 10px 0 0;">Next-Gen Wealth</p>
                    </div>
                    <div style="padding: 30px; background: #f9f9f9;">
                        <h2 style="color: #333; margin-bottom: 20px;">${title}</h2>
                        <div style="background: white; padding: 20px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
                            <p style="color: #555; line-height: 1.6; margin-bottom: 20px;">${message}</p>
                            ${actionUrl ? `
                            <div style="text-align: center; margin: 30px 0;">
                                <a href="${config.clientURL}${actionUrl}"
                                    style="background: linear-gradient(135deg, #d4af37 0%, #059669 100%);
                                    color: white; padding: 12px 30px; text-decoration: none;
                                    border-radius: 5px; font-weight: bold; display: inline-block;">
                                    View Details
                                </a>
                            </div>` : ''}
                        </div>
                        <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #eee; text-align: center; color: #888; font-size: 12px;">
                            <p>This is an automated message from Liquidated. Please do not reply to this email.</p>
                            <p>© ${new Date().getFullYear()} Liquidated. All rights reserved.</p>
                        </div>
                    </div>
                </div>
            `;
            await sendEmail(user.email, emailSubject, emailHtml);
        }

        return notification;
    } catch (error) {
        console.error('Error creating notification:', error);
        return null;
    }
};

// ==================== TRANSACTIONS ====================
const createTransaction = async (userId, type, amount, description, status = 'completed', metadata = {}) => {
    console.log(`🔄 [TXN] ${type} user=${userId} amount=${amount} status=${status}`);
    try {
        const user = await User.findById(userId);
        if (!user) throw new Error(`User ${userId} not found`);

        const beforeState = {
            balance: user.balance || 0,
            total_earnings: user.total_earnings || 0,
            referral_earnings: user.referral_earnings || 0,
            withdrawable_earnings: user.withdrawable_earnings || 0,
            total_withdrawn: user.total_withdrawn || 0
        };

        if (status === 'completed') {
            switch (type) {
                case 'daily_interest':
                    if (amount > 0) user.total_earnings = beforeState.total_earnings + amount;
                    break;
                case 'referral_bonus':
                    if (amount > 0) user.referral_earnings = beforeState.referral_earnings + amount;
                    break;
                case 'investment': {
                    const investmentAmount = Math.abs(amount);
                    user.balance = Math.max(0, beforeState.balance - investmentAmount);
                    user.total_investments = (user.total_investments || 0) + investmentAmount;
                    user.last_investment_date = new Date();
                    if (!user.first_investment_amount || user.first_investment_amount === 0) {
                        user.first_investment_amount = investmentAmount;
                        user.first_investment_date = new Date();
                    }
                    break;
                }
                case 'deposit':
                    if (amount > 0) {
                        user.balance = beforeState.balance + amount;
                        user.total_deposits = (user.total_deposits || 0) + amount;
                        user.last_deposit_date = new Date();
                    }
                    break;
                case 'withdrawal': {
                    const withdrawalAmount = Math.abs(amount);
                    user.total_withdrawn = beforeState.total_withdrawn + withdrawalAmount;
                    user.total_withdrawals = (user.total_withdrawals || 0) + withdrawalAmount;
                    user.last_withdrawal_date = new Date();
                    break;
                }
                case 'bonus':
                case 'refund':
                    if (amount > 0) user.balance = beforeState.balance + amount;
                    break;
            }
        }

        await user.save();

        const afterState = {
            balance: user.balance,
            total_earnings: user.total_earnings,
            referral_earnings: user.referral_earnings,
            withdrawable_earnings: user.withdrawable_earnings,
            total_withdrawn: user.total_withdrawn
        };

        const transaction = new Transaction({
            user: userId, type, amount, description, status,
            reference: generateReference('TXN'),
            balance_before: beforeState.balance,
            balance_after: afterState.balance,
            earnings_before: beforeState.total_earnings,
            earnings_after: afterState.total_earnings,
            referral_earnings_before: beforeState.referral_earnings,
            referral_earnings_after: afterState.referral_earnings,
            withdrawable_before: beforeState.withdrawable_earnings,
            withdrawable_after: afterState.withdrawable_earnings,
            metadata: { ...metadata, processedAt: new Date(), user_id: userId, transaction_type: type }
        });
        await transaction.save();

        emitToUser(userId, 'balance-updated', {
            balance: afterState.balance,
            total_earnings: afterState.total_earnings,
            referral_earnings: afterState.referral_earnings,
            withdrawable_earnings: afterState.withdrawable_earnings,
            total_withdrawn: afterState.total_withdrawn,
            reserved_earnings: user.reserved_earnings || 0,
            timestamp: new Date().toISOString()
        });

        return { success: true, transaction };
    } catch (error) {
        console.error('❌ [TXN] Failed:', error);
        return { success: false, error: error.message };
    }
};

// ==================== EARNINGS RECALC ====================
const recalculateUserEarnings = async (userId, session = null) => {
    console.log(`🔍 Recalculating earnings for user ${userId}`);

    const query = Transaction.find({ user: userId, status: 'completed' }).session(session);
    const transactions = await query.lean();

    let totalEarnings = 0;
    let referralEarnings = 0;
    let totalWithdrawn = 0;

    transactions.forEach(tx => {
        if (tx.type === 'daily_interest' && tx.amount > 0) totalEarnings += tx.amount;
        else if (tx.type === 'referral_bonus' && tx.amount > 0) referralEarnings += tx.amount;
        else if (tx.type === 'withdrawal' && tx.amount < 0) totalWithdrawn += Math.abs(tx.amount);
    });

    const withdrawableEarnings = Math.max(0, totalEarnings + referralEarnings - totalWithdrawn);

    const updateData = {
        total_earnings: totalEarnings,
        referral_earnings: referralEarnings,
        total_withdrawn: totalWithdrawn,
        withdrawable_earnings: withdrawableEarnings
    };

    const user = await User.findByIdAndUpdate(userId, updateData, { new: true, session })
        .select('-password');

    if (!user) throw new Error('User not found during earnings recalculation');

    return { user, recalculated: updateData, transactionCount: transactions.length };
};

const autoCorrectAllUsersEarnings = async () => {
    return withCronLock('autoCorrectEarnings', config.cronLockTTL.autoCorrectEarnings, async () => {
        console.log('🔄 Running auto-correct earnings for all users...');
        const users = await User.find({}, '_id').lean();
        let correctedCount = 0;
        let errorCount = 0;

        for (const u of users) {
            let session;
            try {
                session = await mongoose.startSession();
                session.startTransaction();

                const userBefore = await User.findById(u._id).session(session);
                const recalc = await recalculateUserEarnings(u._id, session);

                const changed =
                    Math.abs((userBefore.total_earnings || 0) - recalc.recalculated.total_earnings) > 0.01 ||
                    Math.abs((userBefore.referral_earnings || 0) - recalc.recalculated.referral_earnings) > 0.01 ||
                    Math.abs((userBefore.total_withdrawn || 0) - recalc.recalculated.total_withdrawn) > 0.01 ||
                    Math.abs((userBefore.withdrawable_earnings || 0) - recalc.recalculated.withdrawable_earnings) > 0.01;

                if (changed) {
                    correctedCount++;
                    await AdminAudit.create([{
                        admin_id: null,
                        actor: 'system',
                        action: 'auto_correct_earnings',
                        target_type: 'user',
                        target_id: u._id,
                        details: {
                            before: {
                                total_earnings: userBefore.total_earnings,
                                referral_earnings: userBefore.referral_earnings,
                                total_withdrawn: userBefore.total_withdrawn,
                                withdrawable_earnings: userBefore.withdrawable_earnings
                            },
                            after: recalc.recalculated
                        }
                    }], { session });
                }

                await session.commitTransaction();
            } catch (err) {
                errorCount++;
                console.error(`❌ Error correcting user ${u._id}:`, err.message);
                if (session) {
                    try { await session.abortTransaction(); } catch (_) { /* noop */ }
                }
            } finally {
                if (session) session.endSession();
            }
        }

        console.log(`✅ Auto-correct completed. Corrected: ${correctedCount}, Errors: ${errorCount}`);
        return { correctedCount, errorCount };
    });
};

// ==================== DAILY INTEREST ====================
const addDailyInterestForInvestment = async (investment) => {
    console.log(`💰 [INTEREST] Investment: ${investment._id}`);
    try {
        if (investment.status !== 'active') return { success: false, error: 'Investment not active' };
        if (investment.end_date <= new Date()) {
            investment.status = 'completed';
            await investment.save();
            return { success: false, error: 'Investment expired' };
        }

        const plan = await InvestmentPlan.findById(investment.plan);
        if (!plan) return { success: false, error: 'Plan not found' };

        const dailyEarning = (investment.amount * plan.daily_interest) / 100;

        investment.earned_so_far += dailyEarning;
        investment.interest_added_count += 1;
        investment.last_earning_date = new Date();
        investment.next_interest_date = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await investment.save();

        await createTransaction(
            investment.user, 'daily_interest', dailyEarning,
            `Daily interest from ${plan.name} investment (Day ${investment.interest_added_count})`,
            'completed',
            {
                investment_id: investment._id,
                plan_name: plan.name,
                daily_interest_rate: plan.daily_interest,
                investment_amount: investment.amount,
                interest_day: investment.interest_added_count,
                total_days: plan.duration,
                next_interest_date: investment.next_interest_date
            }
        );

        if (investment.interest_added_count >= plan.duration) {
            investment.status = 'completed';
            await investment.save();
            await createNotification(
                investment.user, 'Investment Completed',
                `Your investment in ${plan.name} has completed. Total earnings: ₦${investment.earned_so_far.toLocaleString()}`,
                'investment', '/investments'
            );
        }

        return {
            success: true, dailyEarning,
            interestAddedCount: investment.interest_added_count,
            totalEarned: investment.earned_so_far,
            nextInterestDate: investment.next_interest_date
        };
    } catch (error) {
        console.error(`❌ [INTEREST] Error:`, error);
        return { success: false, error: error.message };
    }
};

const calculateDailyInterest = async () => {
    return withCronLock('dailyInterest', config.cronLockTTL.dailyInterest, async () => {
        console.log('🔄 Running daily interest calculation...');
        const now = new Date();
        const activeInvestments = await Investment.find({
            status: 'active',
            end_date: { $gt: now },
            $or: [
                { next_interest_date: { $lte: now } },
                { next_interest_date: { $exists: false } }
            ]
        }).populate('plan').populate('user');

        let totalInterestPaid = 0;
        let investmentsUpdated = 0;

        for (const investment of activeInvestments) {
            const result = await addDailyInterestForInvestment(investment);
            if (result.success) {
                totalInterestPaid += result.dailyEarning;
                investmentsUpdated++;
            }
        }

        console.log(`✅ Daily interest done: ${investmentsUpdated} updated, ₦${totalInterestPaid.toLocaleString()} paid`);
        return { success: true, investmentsUpdated, totalInterestPaid };
    });
};

const addFirstDayInterest = async (investment) => {
    try {
        console.log(`💰 [FIRST INTEREST] Investment: ${investment._id}`);
        const plan = await InvestmentPlan.findById(investment.plan);
        if (!plan) return { success: false, error: 'Plan not found' };

        const dailyEarning = (investment.amount * plan.daily_interest) / 100;

        investment.earned_so_far = dailyEarning;
        investment.interest_added_count = 1;
        investment.last_earning_date = new Date();
        investment.next_interest_date = new Date(Date.now() + 24 * 60 * 60 * 1000);
        investment.total_interest_days = plan.duration;
        await investment.save();

        await createTransaction(
            investment.user, 'daily_interest', dailyEarning,
            `First day interest from ${plan.name} investment`,
            'completed',
            {
                investment_id: investment._id,
                plan_name: plan.name,
                daily_interest_rate: plan.daily_interest,
                investment_amount: investment.amount,
                interest_day: 1,
                total_days: plan.duration,
                next_interest_date: investment.next_interest_date,
                is_first_day: true
            }
        );

        return { success: true, dailyEarning, nextInterestDate: investment.next_interest_date };
    } catch (error) {
        console.error(`❌ [FIRST INTEREST] Error:`, error);
        return { success: false, error: error.message };
    }
};

// ==================== REFERRAL ====================
const awardReferralCommission = async (referredUserId, investmentAmount, investmentId) => {
    try {
        console.log(`🎯 Referral check: user=${referredUserId}, amount=₦${investmentAmount}, rate=${config.referralCommissionPercent}%`);
        const referredUser = await User.findById(referredUserId);
        if (!referredUser || !referredUser.referred_by) return { success: false, message: 'No referrer' };

        const userInvestments = await Investment.countDocuments({
            user: referredUserId,
            status: { $in: ['active', 'completed'] }
        });
        if (userInvestments > 1) return { success: false, message: 'Not first investment' };

        const referral = await Referral.findOne({
            referred_user: referredUserId,
            referrer: referredUser.referred_by,
            first_investment_commission_paid: false
        });
        if (!referral) return { success: false, message: 'Commission already paid or referral not found' };

        const commission = investmentAmount * (config.referralCommissionPercent / 100);

        const txResult = await createTransaction(
            referredUser.referred_by, 'referral_bonus', commission,
            `Referral commission from ${referredUser.full_name}'s first investment (${config.referralCommissionPercent}%)`,
            'completed',
            {
                referred_user_id: referredUserId,
                investment_id: investmentId,
                commission_percentage: config.referralCommissionPercent,
                first_investment_amount: investmentAmount
            }
        );
        if (!txResult.success) throw new Error('Failed to create referral commission transaction');

        referral.total_commission = commission;
        referral.first_investment_commission_paid = true;
        referral.first_investment_amount = investmentAmount;
        referral.first_investment_date = new Date();
        referral.earnings_paid = true;
        referral.paid_at = new Date();
        referral.status = 'completed';
        referral.commission_transaction_id = txResult.transaction._id;
        await referral.save();

        // Update referrer's confirmed count (used by awards eligibility engine)
        await User.findByIdAndUpdate(referredUser.referred_by, {
            $inc: { confirmed_referral_count: 1 }
        });

        await createNotification(
            referredUser.referred_by, 'Referral Commission Earned!',
            `You earned ₦${commission.toLocaleString()} (${config.referralCommissionPercent}%) from ${referredUser.full_name}'s first investment.`,
            'referral', '/referrals'
        );

        // Check for newly unlocked award tiers
        try {
            await checkAndNotifyNewAwardTiers(referredUser.referred_by);
        } catch (awardErr) {
            console.error('Award tier notification error (non-fatal):', awardErr.message);
        }

        return { success: true, commission, referrerId: referredUser.referred_by, transaction: txResult.transaction };
    } catch (error) {
        console.error('❌ Referral commission error:', error);
        return { success: false, error: error.message };
    }
};

// ==================== AML ====================
const checkAmlCompliance = async (userId, transactionType, amount, metadata = {}) => {
    try {
        if (amount <= 0) return { riskScore: 0, flagged: false };

        let riskScore = 0;
        const flaggedReasons = [];

        if (amount > 1000000) { riskScore += 40; flaggedReasons.push('Large transaction amount'); }
        if (amount > 500000 && transactionType === 'withdrawal') { riskScore += 30; flaggedReasons.push('Large withdrawal request'); }

        const recentTransactions = await Transaction.countDocuments({
            user: userId,
            createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        });
        if (recentTransactions > 10) { riskScore += 20; flaggedReasons.push('High transaction frequency'); }

        const user = await User.findById(userId);
        if (user) {
            const accountAgeDays = (new Date() - user.createdAt) / (1000 * 60 * 60 * 24);
            if (accountAgeDays < 7 && amount > 100000) { riskScore += 30; flaggedReasons.push('New account with large transaction'); }
        }

        if (riskScore > 50) {
            await AmlMonitoring.create({
                user: userId,
                transaction_type: transactionType,
                amount,
                flagged_reason: flaggedReasons.join(', '),
                risk_score: riskScore,
                status: 'pending_review',
                metadata
            });
            emitToAdmins('aml-flagged', { userId, transactionType, amount, riskScore, reasons: flaggedReasons });
        }

        return { riskScore, flagged: riskScore > 50, reasons: flaggedReasons };
    } catch (error) {
        console.error('AML check error:', error);
        return { riskScore: 0, flagged: false, reasons: [] };
    }
};

// ==================== AWARDS ENGINE ====================
const img = (file) => `${config.awardsFrontendURL}/${file}`;

const TIER_SEED = [
    { tier_number: 1,  slug: 'starter',                   title: 'Starter',                   referrals_required: 5,    reward_name: 'Branded T-Shirt + Digital Appreciation Badge', reward_description: 'A premium LIQUIDATED branded tee shipped to your door, plus a permanent digital appreciation badge on your profile.', reward_category: 'merch',       reward_icon: '👕', image_url: img('IMG_20260924_130915.png'), accent_color: '#a8861f', estimated_value_ngn: 25000,    display_order: 1,  terms: 'One claim per account.' },
    { tier_number: 2,  slug: 'silver-ambassador',         title: 'Silver Ambassador',         referrals_required: 30,   reward_name: 'Smart Watch',                                  reward_description: 'A modern smart watch with health tracking, notifications, and multi-day battery life.',                          reward_category: 'electronics', reward_icon: '⌚', image_url: img('IMG_20260924_130957.png'), accent_color: '#c0c0c0', estimated_value_ngn: 180000,   display_order: 2,  terms: 'KYC verification required.' },
    { tier_number: 3,  slug: 'gold-ambassador',           title: 'Gold Ambassador',           referrals_required: 50,   reward_name: 'Premium Backpack + Exclusive VIP Badge',      reward_description: 'A durable premium backpack with embroidered LIQUIDATED branding, plus an exclusive VIP badge on your profile.', reward_category: 'merch',       reward_icon: '🎒', image_url: img('IMG_20260924_131037.png'), accent_color: '#d4af37', estimated_value_ngn: 120000,   display_order: 3,  terms: 'VIP badge is non-transferable.' },
    { tier_number: 4,  slug: 'platinum-ambassador',       title: 'Platinum Ambassador',       referrals_required: 75,   reward_name: 'Premium Gift Package',                        reward_description: 'A curated premium gift package delivered to your door.',                                                    reward_category: 'merch',       reward_icon: '🎁', image_url: img('IMG_20260924_131125.png'), accent_color: '#e5e4e2', estimated_value_ngn: 350000,   display_order: 4,  terms: 'Contents may vary by availability.' },
    { tier_number: 5,  slug: 'diamond-ambassador',        title: 'Diamond Ambassador',        referrals_required: 100,  reward_name: 'Smartphone',                                   reward_description: 'A current-generation smartphone, unlocked and ready to use. Colour subject to availability.',                reward_category: 'electronics', reward_icon: '📱', image_url: img('IMG_20260924_131216.png'), accent_color: '#b9f2ff', estimated_value_ngn: 650000,   display_order: 5,  terms: 'KYC mandatory. Delivery within Nigeria.' },
    { tier_number: 6,  slug: 'royal-ambassador',          title: 'Royal Ambassador',          referrals_required: 150,  reward_name: 'Tablet',                                       reward_description: 'A premium tablet with stylus support — built for productivity and entertainment.',                          reward_category: 'electronics', reward_icon: '📲', image_url: img('IMG_20260924_131253.png'), accent_color: '#f6d054', estimated_value_ngn: 900000,   display_order: 6,  terms: 'KYC mandatory. Delivery within Nigeria.' },
    { tier_number: 7,  slug: 'diamond-ambassador-award',  title: 'Diamond Ambassador Award',  referrals_required: 170,  reward_name: 'Diamond Ambassador Award',                    reward_description: 'Formal recognition as a LIQUIDATED Diamond Ambassador with a physical award trophy.',                       reward_category: 'merch',       reward_icon: '🏅', image_url: img('IMG_20260924_131333.png'), accent_color: '#b9f2ff', estimated_value_ngn: 250000,   display_order: 7,  terms: 'Physical award shipped by courier.' },
    { tier_number: 8,  slug: 'elite-ambassador',          title: 'Elite Ambassador',          referrals_required: 250,  reward_name: 'Premium Laptop',                              reward_description: 'A high-performance laptop suitable for professional work, creative projects, and development.',              reward_category: 'electronics', reward_icon: '💻', image_url: img('IMG_20260924_131415.png'), accent_color: '#10b981', estimated_value_ngn: 1800000,  display_order: 8,  terms: 'Specification confirmed before dispatch.' },
    { tier_number: 9,  slug: 'executive-ambassador-280',  title: 'Executive Ambassador',      referrals_required: 280,  reward_name: 'Elite Ambassador Award',                      reward_description: 'Formal recognition as an Elite Ambassador with a premium physical trophy.',                                 reward_category: 'merch',       reward_icon: '🏆', image_url: img('IMG_20260924_131501.png'), accent_color: '#059669', estimated_value_ngn: 400000,   display_order: 9,  terms: 'Physical award shipped by courier.' },
    { tier_number: 10, slug: 'premium-ambassador',        title: 'Premium Ambassador',        referrals_required: 350,  reward_name: 'Smart TV',                                     reward_description: 'A large-format 4K smart television with HDR support and built-in streaming apps.',                          reward_category: 'electronics', reward_icon: '📺', image_url: img('IMG_20260924_131538.png'), accent_color: '#34d399', estimated_value_ngn: 2200000,  display_order: 10, terms: 'Installation support in select cities.' },
    { tier_number: 11, slug: 'executive-ambassador-500',  title: 'Executive Ambassador',      referrals_required: 500,  reward_name: 'Executive Ambassador Award',                  reward_description: 'Formal recognition as a LIQUIDATED Executive Ambassador with a premium trophy.',                          reward_category: 'merch',       reward_icon: '🥇', image_url: img('IMG_20260924_131620.png'), accent_color: '#059669', estimated_value_ngn: 600000,   display_order: 11, terms: 'Physical award shipped by courier.' },
    { tier_number: 12, slug: 'platinum-ambassador-750',   title: 'Platinum Ambassador',       referrals_required: 750,  reward_name: 'Flagship Smartphone',                         reward_description: 'The flagship device of your choice from a curated list of premium smartphones.',                            reward_category: 'electronics', reward_icon: '📱', image_url: img('IMG_20260924_131711.png'), accent_color: '#e5e4e2', estimated_value_ngn: 1500000,  display_order: 12, terms: 'Model selection confirmed with your account manager.' },
    { tier_number: 13, slug: 'crown-ambassador',          title: 'Crown Ambassador',          referrals_required: 1000, reward_name: 'Crown Ambassador Award',                      reward_description: 'Our Crown-tier award — flagship smartphone plus formal Crown Ambassador recognition.',                       reward_category: 'electronics', reward_icon: '👑', image_url: img('IMG_20260924_131748.png'), accent_color: '#f6d054', estimated_value_ngn: 2500000,  display_order: 13, terms: 'Subject to formal award agreement.' },
    { tier_number: 14, slug: 'royal-partner',             title: 'Royal Partner',             referrals_required: 1500, reward_name: 'Major Lifestyle Reward — Vehicle Contribution',reward_description: 'A substantial cash contribution toward a vehicle of your choice, paid directly to a verified dealer.',       reward_category: 'vehicle',     reward_icon: '🚘', image_url: img('IMG_20260924_131825.png'), accent_color: '#fbbf24', estimated_value_ngn: 5000000,  display_order: 14, terms: 'Paid to a verified dealer only.' },
    { tier_number: 15, slug: 'elite-partner',             title: 'Elite Partner',             referrals_required: 2000, reward_name: 'LIQUIDATED Elite Ambassador Award + Luxury Vehicle', reward_description: 'Our flagship award: a luxury vehicle plus formal recognition as a LIQUIDATED Elite Ambassador.',       reward_category: 'vehicle',     reward_icon: '🏆', image_url: img('IMG_20260924_131907.png'), accent_color: '#e9bd3d', estimated_value_ngn: 25000000, display_order: 15, terms: 'Subject to formal award agreement and AML review.' },
    { tier_number: 16, slug: 'strategic-partner',         title: 'Strategic Partner',         referrals_required: 2001, reward_name: 'Strategic Partnership Program + Dedicated Account Manager', reward_description: 'An invitation into the LIQUIDATED Strategic Partnership Program with a dedicated account manager and revenue share.', reward_category: 'partnership', reward_icon: '🤝', image_url: img('IMG_20260924_131950.png'), accent_color: '#34d399', estimated_value_ngn: 0,        display_order: 16, terms: 'Entry by invitation following partnership review.' }
];

async function seedAwardTiers() {
    const seedNumbers = TIER_SEED.map(t => t.tier_number);
    const removed = await AwardTier.deleteMany({ tier_number: { $nin: seedNumbers } });

    let created = 0, updated = 0;
    for (const t of TIER_SEED) {
        const existing = await AwardTier.findOne({ tier_number: t.tier_number });
        if (existing) { await AwardTier.findByIdAndUpdate(existing._id, t); updated++; }
        else          { await AwardTier.create(t);                          created++; }
    }
    console.log(`🏆 Award tiers seeded: ${created} created, ${updated} updated, ${removed.deletedCount} removed`);
    return { created, updated, removed: removed.deletedCount };
}

async function computeUserAwardStatus(userId) {
    const user = await User.findById(userId).lean();
    if (!user) throw new Error('User not found');

    const confirmed = await Referral.countDocuments({ referrer: userId, first_investment_commission_paid: true });
    const total     = await Referral.countDocuments({ referrer: userId });
    const pending   = total - confirmed;

    const tiers  = await AwardTier.find({ is_active: true }).sort({ referrals_required: 1 }).lean();
    const claims = await AwardClaim.find({ user: userId }).lean();
    const claimedTierNums = new Set(claims.map(c => c.tier_number));

    const unlocked = [], claimable = [];
    let nextTier = null;

    for (const t of tiers) {
        const reached = confirmed >= t.referrals_required;
        if (reached) {
            unlocked.push(t.tier_number);
            if (!claimedTierNums.has(t.tier_number)) claimable.push(t);
        } else if (!nextTier) {
            nextTier = {
                ...t,
                referrals_needed: t.referrals_required - confirmed,
                progress_percent: Math.min(100, (confirmed / t.referrals_required) * 100)
            };
        }
    }

    let avgDaily = 0;
    let etaDays = null;
    if (nextTier) {
        const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const recent = await Referral.countDocuments({
            referrer: userId, first_investment_commission_paid: true,
            first_investment_date: { $gte: cutoff }
        });
        avgDaily = recent / 30;
        if (avgDaily >= 0.5) {
            etaDays = Math.ceil(nextTier.referrals_needed / avgDaily);
        }
    }

    return {
        confirmed_referrals: confirmed,
        total_referrals: total,
        pending_referrals: pending,
        unlocked_tiers: unlocked,
        claimable_tiers: claimable,
        next_tier: nextTier,
        claims,
        referral_code: user.referral_code,
        referral_link: `${config.clientURL}/register?ref=${user.referral_code}`,
        avg_daily: avgDaily,
        eta_days: etaDays,
        tiers
    };
}

async function checkAndNotifyNewAwardTiers(userId) {
    try {
        const status = await computeUserAwardStatus(userId);
        if (!status.unlocked_tiers || status.unlocked_tiers.length === 0) return;

        // Notify for any newly unlocked tiers that haven't been claimed
        for (const tier of status.claimable_tiers) {
            const alreadyNotified = await Notification.findOne({
                user: userId,
                'metadata.award_tier_number': tier.tier_number,
                type: 'award'
            }).lean();
            if (alreadyNotified) continue;

            await createNotification(
                userId,
                `🏆 New Award Unlocked — ${tier.title}`,
                `Congratulations! You've unlocked the ${tier.title} tier (${tier.referrals_required} confirmed referrals). Reward: ${tier.reward_name}. Claim it from your awards page.`,
                'award',
                '/awards',
                { award_tier_number: tier.tier_number, award_tier_slug: tier.slug }
            );

            emitToUser(userId, 'award-unlocked', {
                tier_number: tier.tier_number,
                title: tier.title,
                reward_name: tier.reward_name,
                reward_icon: tier.reward_icon,
                image_url: tier.image_url
            });
        }
    } catch (err) {
        console.error('checkAndNotifyNewAwardTiers error:', err.message);
    }
}

// ==================== DATABASE INIT ====================
const initializeDatabase = async () => {
    console.log('🔄 Initializing database...');
    await mongoose.connect(config.mongoURI, {
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        maxPoolSize: 10,
        retryWrites: true
    });
    console.log('✅ MongoDB connected successfully');

    await Promise.all([
        User.syncIndexes(),
        Investment.syncIndexes(),
        Deposit.syncIndexes(),
        Withdrawal.syncIndexes(),
        Transaction.syncIndexes(),
        CronLock.syncIndexes(),
        AwardTier.syncIndexes(),
        AwardClaim.syncIndexes(),
        Referral.syncIndexes()
    ]).catch(err => console.warn('Index sync warning:', err.message));

    await createAdminUser();
    await createDefaultInvestmentPlans();
    await seedAwardTiers();
    await backfillConfirmedReferralCounts();

    console.log('✅ Database initialization completed');
};

const backfillConfirmedReferralCounts = async () => {
    try {
        const result = await Referral.aggregate([
            { $match: { first_investment_commission_paid: true } },
            { $group: { _id: '$referrer', count: { $sum: 1 } } }
        ]);

        let fixed = 0;
        for (const row of result) {
            const user = await User.findById(row._id);
            if (user && user.confirmed_referral_count !== row.count) {
                user.confirmed_referral_count = row.count;
                await user.save();
                fixed++;
            }
        }
        if (fixed > 0) console.log(`🔁 Backfilled confirmed_referral_count for ${fixed} users`);
    } catch (err) {
        console.warn('Backfill confirmed_referral_count skipped:', err.message);
    }
};

const createDefaultInvestmentPlans = async () => {
    const firstThreeDuration = config.planDurations.firstThree;
    const nextThreeDuration = config.planDurations.nextThree;
    const remainingDuration = config.planDurations.remaining;

    const defaultPlans = [
        {
            name: 'StableGrowth Ltd.',
            description: 'Invest in a diversified portfolio of blue‑chip stocks with stable returns.',
            min_amount: 3000, max_amount: 50000,
            daily_interest: 10, total_interest: 15 * firstThreeDuration,
            duration: firstThreeDuration, risk_level: 'low', raw_material: 'Stocks',
            category: 'stocks', is_popular: true,
            features: ['Low Risk', 'Stable Returns', 'Beginner Friendly', 'Daily Payouts'],
            color: 'rgba(16,185,129,0.14)', icon: '📈', display_order: 1
        },
        {
            name: 'Global Equity Fund',
            description: 'A mix of international stocks offering medium risk and higher returns.',
            min_amount: 50000, max_amount: 500000,
            daily_interest: 10, total_interest: 15 * firstThreeDuration,
            duration: firstThreeDuration, risk_level: 'medium', raw_material: 'Stocks',
            category: 'stocks', is_popular: true,
            features: ['Medium Risk', 'Higher Returns', 'International Exposure', 'Daily Payouts'],
            color: 'rgba(212,175,55,0.14)', icon: '🌍', display_order: 2
        },
        {
            name: 'HighYield Ventures',
            description: 'Aggressive growth stocks for maximum returns.',
            min_amount: 100000, max_amount: 1000000,
            daily_interest: 9, total_interest: 9 * firstThreeDuration,
            duration: firstThreeDuration, risk_level: 'high', raw_material: 'Stocks',
            category: 'stocks', is_popular: true,
            features: ['High Risk', 'Maximum Returns', 'Premium Investment', 'Aggressive Growth'],
            color: 'rgba(220,38,38,0.12)', icon: '🚀', display_order: 3
        },
        {
            name: 'Dividend Kings Inc.',
            description: 'Companies with a long history of consistent dividend payments.',
            min_amount: 5500, max_amount: 25000,
            daily_interest: 9, total_interest: 9 * nextThreeDuration,
            duration: nextThreeDuration, risk_level: 'low', raw_material: 'Stocks',
            category: 'stocks', is_popular: false,
            features: ['Low Risk', 'Consistent Dividends', 'Daily Payouts', 'Steady Income'],
            color: 'rgba(139,69,19,0.12)', icon: '💵', display_order: 4
        },
        {
            name: 'Industrial Select Fund',
            description: 'Focus on industrial and manufacturing sector stocks.',
            min_amount: 15000, max_amount: 150000,
            daily_interest: 10, total_interest: 10 * nextThreeDuration,
            duration: nextThreeDuration, risk_level: 'medium', raw_material: 'Stocks',
            category: 'stocks', is_popular: false,
            features: ['Medium Risk', 'Industrial Focus', 'Portfolio Diversification', 'Regular Returns'],
            color: 'rgba(192,192,192,0.12)', icon: '🏭', display_order: 5
        },
        {
            name: 'Sustainable Future ETF',
            description: 'Invest in environmentally and socially responsible companies.',
            min_amount: 20000, max_amount: 200000,
            daily_interest: 10, total_interest: 10 * nextThreeDuration,
            duration: nextThreeDuration, risk_level: 'medium', raw_material: 'Stocks',
            category: 'stocks', is_popular: false,
            features: ['ESG Focus', 'Sustainable', 'Future‑Proof', 'Daily Returns'],
            color: 'rgba(16,185,129,0.14)', icon: '🌱', display_order: 6
        },
        {
            name: 'Energy Sector Leaders',
            description: 'Top companies in the energy sector, including renewables.',
            min_amount: 75000, max_amount: 750000,
            daily_interest: 13, total_interest: 13 * remainingDuration,
            duration: remainingDuration, risk_level: 'high', raw_material: 'Stocks',
            category: 'stocks', is_popular: false,
            features: ['High Returns', 'Energy Transition', 'Global Market', 'Premium Investment'],
            color: 'rgba(212,175,55,0.14)', icon: '⚡', display_order: 7
        },
        {
            name: 'Consumer Staples Fund',
            description: 'Stocks of essential consumer goods companies with steady demand.',
            min_amount: 30000, max_amount: 300000,
            daily_interest: 11, total_interest: 11 * remainingDuration,
            duration: remainingDuration, risk_level: 'medium', raw_material: 'Stocks',
            category: 'stocks', is_popular: false,
            features: ['Essential Goods', 'Steady Demand', 'Resilient', 'Regular Returns'],
            color: 'rgba(255,107,107,0.12)', icon: '🛒', display_order: 8
        }
    ];

    try {
        for (const planData of defaultPlans) {
            const existing = await InvestmentPlan.findOne({ name: planData.name });
            if (!existing) {
                await InvestmentPlan.create(planData);
                console.log(`✅ Created plan: ${planData.name}`);
            } else {
                await InvestmentPlan.findByIdAndUpdate(existing._id, planData);
                console.log(`✅ Updated plan: ${planData.name}`);
            }
        }
        console.log(`📊 Total investment plans: ${defaultPlans.length}`);
    } catch (error) {
        console.error('Error creating default investment plans:', error);
    }
};

const createAdminUser = async () => {
    try {
        const adminEmail = process.env.ADMIN_EMAIL || 'admin@liquidated.com';
        const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123456';

        const existingAdmin = await User.findOne({ email: adminEmail });
        if (existingAdmin) {
            if (existingAdmin.role !== 'super_admin') {
                existingAdmin.role = 'super_admin';
                await existingAdmin.save();
                console.log('✅ Admin role updated to super_admin');
            } else {
                console.log('✅ Admin already exists');
            }
            return;
        }

        const admin = new User({
            full_name: 'Liquidated Admin',
            email: adminEmail,
            phone: '09161806424',
            password: adminPassword,
            role: 'super_admin',
            balance: 1000000,
            total_earnings: 500000,
            referral_earnings: 200000,
            withdrawable_earnings: 700000,
            kyc_verified: true, kyc_status: 'verified',
            is_active: true, is_verified: true,
            email_notifications: true,
            total_deposits: 2000000, total_withdrawals: 500000, total_investments: 1500000,
            account_status: 'active'
        });
        await admin.save();

        await createNotification(admin._id, 'Welcome Admin!',
            'Your admin account has been successfully created.', 'success', '/admin/dashboard');

        console.log('\n🎉 =========== ADMIN SETUP COMPLETED ===========');
        console.log(`📧 Login Email: ${adminEmail}`);
        console.log(`🔑 Login Password: ${adminPassword}`);
        console.log(`👉 Login at: ${config.clientURL}/admin/login`);
        console.log('============================================\n');
    } catch (error) {
        console.error('Admin creation error:', error);
    }
};

// ==================== HEALTH & ROOT ====================
app.get('/health', async (req, res) => {
    try {
        const health = {
            success: true, status: 'OK',
            timestamp: new Date().toISOString(),
            version: '59.0.0',
            environment: config.nodeEnv,
            database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
            cloudinary: {
                configured: !!(config.cloudinary.cloud_name && config.cloudinary.api_key && config.cloudinary.api_secret),
                cloud_name: config.cloudinary.cloud_name || null
            },
            uptime: process.uptime(),
            memory: {
                rss: `${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
                heapTotal: `${Math.round(process.memoryUsage().heapTotal / 1024 / 1024)}MB`,
                heapUsed: `${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`
            },
            stats: {
                users: await User.countDocuments({}),
                investments: await Investment.countDocuments({}),
                deposits: await Deposit.countDocuments({}),
                withdrawals: await Withdrawal.countDocuments({}),
                plans: await InvestmentPlan.countDocuments({}),
                award_tiers: await AwardTier.countDocuments({}),
                award_claims: await AwardClaim.countDocuments({})
            }
        };
        res.json(health);
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/', (req, res) => {
    res.json({
        success: true,
        message: '🚀 Liquidated Backend v59.0 - Production / Awards Edition',
        version: '59.0.0',
        timestamp: new Date().toISOString(),
        status: 'Operational',
        environment: config.nodeEnv,
        features: {
            cloudinary_storage: '✅ ENABLED (ephemeral-disk-proof uploads)',
            kyc_private_assets: '✅ ENABLED (authenticated + signed URLs)',
            body_parser_fix: '✅ ENABLED (forces JSON parsing on PUT with text/plain)',
            hoisting_fix: '✅ ENABLED',
            investment_auto_approval: '✅ ENABLED',
            daily_interest_auto: '✅ ENABLED',
            referral_commission: `${config.referralCommissionPercent}%`,
            admin_controls: '✅ ENABLED',
            real_time_updates: '✅ ENABLED',
            atomic_transactions: '✅ ENABLED',
            secure_sockets: '✅ ENABLED',
            auto_correct_earnings: config.autoCorrectEarnings ? '✅ ENABLED' : '❌ DISABLED',
            separate_balance_and_earnings: '✅ ENABLED (balance = deposits only)',
            deposit_proof_optional: '✅ OPTIONAL',
            reserved_earnings_withdrawals: '✅ ENABLED',
            distributed_cron_locks: '✅ ENABLED',
            auth_protected_uploads: '✅ ENABLED',
            bank_details_validation: '✅ 10-digit account number enforced',
            change_password: '✅ ENABLED',
            extended_preferences: '✅ ENABLED',
            signed_url_endpoint: '✅ ENABLED (/api/files/signed/:publicId)',
            referral_awards_system: '✅ ENABLED (16-tier ladder, /api/awards/*)',
            awards_leaderboard: '✅ ENABLED (/api/awards/leaderboard)',
            awards_admin_review: '✅ ENABLED (/api/admin/awards/*)'
        },
        endpoints: {
            auth: '/api/auth/*',
            change_password: '/api/auth/change-password',
            profile: '/api/profile',
            investments: '/api/investments/*',
            deposits: '/api/deposits/*',
            withdrawals: '/api/withdrawals/*',
            plans: '/api/plans',
            kyc: '/api/kyc/*',
            support: '/api/support/*',
            referrals: '/api/referrals/*',
            awards: '/api/awards/*',
            admin_awards: '/api/admin/awards/*',
            admin: '/api/admin/*',
            upload: '/api/upload',
            signed_files: '/api/files/signed/:publicId',
            forgot_password: '/api/auth/forgot-password',
            health: '/health',
            debug_earnings: '/api/debug/earnings-status/:userId',
            admin_recalc: '/api/admin/users/:id/recalculate-earnings'
        }
    });
});

// ==================== LEGACY AUTH-PROTECTED FILE SERVING ====================
const PUBLIC_FOLDERS = new Set(['general', 'avatars', 'public']);
const RESTRICTED_FOLDERS = new Set(['kyc-documents', 'deposit-proofs', 'investment-proofs', 'support-attachments']);

app.get('/uploads/:folder/:filename', auth, async (req, res) => {
    try {
        const { folder, filename } = req.params;

        if (
            folder.includes('..') || filename.includes('..') ||
            folder.includes('/') || folder.includes('\\') ||
            filename.includes('/') || filename.includes('\\')
        ) {
            return res.status(400).json(formatResponse(false, 'Invalid path'));
        }

        if (!fs.existsSync(path.join(config.uploadDir, folder))) {
            return res.status(404).json(formatResponse(false, 'Folder not found'));
        }

        const filePath = path.join(config.uploadDir, folder, filename);
        if (!fs.existsSync(filePath)) {
            return res.status(404).json(formatResponse(false, 'File not found'));
        }

        const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';
        const isPublic = PUBLIC_FOLDERS.has(folder);

        if (!isPublic && RESTRICTED_FOLDERS.has(folder) && !isAdmin) {
            const [kyc, dep, inv] = await Promise.all([
                KYCSubmission.findOne({
                    $or: [
                        { id_front_url: { $regex: filename } },
                        { id_back_url: { $regex: filename } },
                        { selfie_with_id_url: { $regex: filename } },
                        { address_proof_url: { $regex: filename } }
                    ]
                }).lean(),
                Deposit.findOne({ payment_proof_url: { $regex: filename } }).lean(),
                Investment.findOne({ payment_proof_url: { $regex: filename } }).lean()
            ]);

            const ownerId = kyc?.user || dep?.user || inv?.user;
            if (!ownerId) return res.status(404).json(formatResponse(false, 'File not found'));
            if (ownerId.toString() !== req.user._id.toString()) {
                return res.status(403).json(formatResponse(false, 'Access denied'));
            }
        }

        res.set('X-Content-Type-Options', 'nosniff');
        res.set('Cache-Control', isPublic ? 'public, max-age=86400' : 'private, max-age=3600');

        if (filename.toLowerCase().endsWith('.svg')) {
            res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
            res.set('Content-Type', 'image/svg+xml');
            res.set('Content-Disposition', 'inline');
        }

        res.sendFile(filePath);
    } catch (err) {
        console.error('File serve error:', err);
        res.status(500).json(formatResponse(false, 'Error serving file'));
    }
});

app.get('/api/files/signed/:publicId(*)', auth, async (req, res) => {
    try {
        const publicId = decodeURIComponent(req.params.publicId);
        if (!publicId) return res.status(400).json(formatResponse(false, 'publicId is required'));

        const [kyc, dep, inv] = await Promise.all([
            KYCSubmission.findOne({
                $or: [
                    { id_front_url: { $regex: publicId } },
                    { id_back_url: { $regex: publicId } },
                    { selfie_with_id_url: { $regex: publicId } },
                    { address_proof_url: { $regex: publicId } }
                ]
            }).lean(),
            Deposit.findOne({ payment_proof_url: { $regex: publicId } }).lean(),
            Investment.findOne({ payment_proof_url: { $regex: publicId } }).lean()
        ]);

        const ownerId = kyc?.user || dep?.user || inv?.user;
        const isAdmin = req.user.role === 'admin' || req.user.role === 'super_admin';

        if (!ownerId) return res.status(404).json(formatResponse(false, 'File not found'));
        if (!isAdmin && ownerId.toString() !== req.user._id.toString()) {
            return res.status(403).json(formatResponse(false, 'Access denied'));
        }

        const signedUrl = cloudinary.v2.utils.private_download_url(publicId, 'auto', {
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            type: 'authenticated',
            attachment: false
        });

        res.json(formatResponse(true, 'Signed URL generated', { url: signedUrl }));
    } catch (err) {
        handleError(res, err, 'Error generating signed URL');
    }
});

// ==================== DEBUG ENDPOINTS ====================
app.get('/api/debug/earnings-status/:userId', auth, async (req, res) => {
    try {
        const userId = req.params.userId;
        if (req.user.role !== 'admin' && req.user._id.toString() !== userId) {
            return res.status(403).json(formatResponse(false, 'Unauthorized access'));
        }

        const user = await User.findById(userId);
        if (!user) return res.status(404).json(formatResponse(false, 'User not found'));

        const transactions = await Transaction.find({ user: userId }).sort({ createdAt: -1 }).limit(20);
        const investments = await Investment.find({ user: userId }).populate('plan', 'name daily_interest');

        let calculatedTotalEarnings = 0;
        let calculatedReferralEarnings = 0;
        let calculatedWithdrawn = 0;

        transactions.forEach(t => {
            if (t.status === 'completed') {
                if (t.type === 'daily_interest' && t.amount > 0) calculatedTotalEarnings += t.amount;
                else if (t.type === 'referral_bonus' && t.amount > 0) calculatedReferralEarnings += t.amount;
                else if (t.type === 'withdrawal' && t.amount < 0) calculatedWithdrawn += Math.abs(t.amount);
            }
        });

        const calculatedWithdrawable = Math.max(0,
            calculatedTotalEarnings + calculatedReferralEarnings - calculatedWithdrawn);

        res.json({
            success: true,
            user: {
                email: user.email,
                stored: {
                    balance: user.balance,
                    total_earnings: user.total_earnings,
                    referral_earnings: user.referral_earnings,
                    withdrawable_earnings: user.withdrawable_earnings,
                    reserved_earnings: user.reserved_earnings,
                    total_withdrawn: user.total_withdrawn
                },
                calculated: {
                    total_earnings: calculatedTotalEarnings,
                    referral_earnings: calculatedReferralEarnings,
                    total_withdrawn: calculatedWithdrawn,
                    withdrawable_earnings: calculatedWithdrawable
                },
                discrepancies: {
                    total_earnings: Math.abs(user.total_earnings - calculatedTotalEarnings),
                    referral_earnings: Math.abs(user.referral_earnings - calculatedReferralEarnings),
                    withdrawable_earnings: Math.abs(user.withdrawable_earnings - calculatedWithdrawable)
                }
            },
            transactions: {
                count: transactions.length,
                daily_interest: transactions.filter(t => t.type === 'daily_interest').length,
                referral_bonus: transactions.filter(t => t.type === 'referral_bonus').length,
                withdrawal: transactions.filter(t => t.type === 'withdrawal').length,
                recent: transactions.slice(0, 5).map(t => ({
                    type: t.type, amount: t.amount, description: t.description, createdAt: t.createdAt
                }))
            },
            investments: {
                count: investments.length,
                active: investments.filter(i => i.status === 'active').length,
                total_invested: investments.filter(i => i.status === 'active').reduce((s, i) => s + i.amount, 0),
                total_earned: investments.reduce((s, i) => s + (i.earned_so_far || 0), 0),
                list: investments.map(i => ({
                    plan: i.plan?.name,
                    amount: i.amount,
                    earned_so_far: i.earned_so_far,
                    status: i.status,
                    next_interest_date: i.next_interest_date,
                    interest_added_count: i.interest_added_count,
                    balance_deducted: i.balance_deducted
                }))
            }
        });
    } catch (error) {
        console.error('Earnings status error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/debug/system-status', adminAuth, async (req, res) => {
    try {
        res.json({
            success: true,
            timestamp: new Date().toISOString(),
            system: {
                nodeVersion: process.version,
                platform: process.platform,
                uptime: process.uptime(),
                memoryUsage: process.memoryUsage(),
                cpuUsage: process.cpuUsage()
            },
            database: {
                connected: mongoose.connection.readyState === 1,
                host: mongoose.connection.host,
                name: mongoose.connection.name,
                models: Object.keys(mongoose.connection.models)
            },
            cloudinary: {
                cloud_name: config.cloudinary.cloud_name,
                folder_root: config.cloudinary.folder_root,
                configured: !!(config.cloudinary.cloud_name && config.cloudinary.api_key && config.cloudinary.api_secret)
            },
            config: {
                environment: config.nodeEnv,
                serverURL: config.serverURL,
                clientURL: config.clientURL,
                awardsFrontendURL: config.awardsFrontendURL,
                emailEnabled: config.emailEnabled,
                withdrawalAutoApprove: config.withdrawalAutoApprove,
                referralCommissionOnFirstInvestment: config.referralCommissionOnFirstInvestment,
                referralCommissionPercent: config.referralCommissionPercent,
                allInvestmentsRequireAdminApproval: config.allInvestmentsRequireAdminApproval,
                deductBalanceOnlyOnApproval: config.deductBalanceOnlyOnApproval,
                minWithdrawal: config.minWithdrawal,
                planDurations: config.planDurations,
                autoCorrectEarnings: config.autoCorrectEarnings,
                allowedOrigins: config.allowedOrigins
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== AUTH ROUTES ====================
app.post('/api/auth/register', [
    body('full_name').notEmpty().trim().isLength({ min: 2, max: 100 }),
    body('email').isEmail().normalizeEmail(),
    body('phone').notEmpty().trim(),
    body('password').isLength({ min: 6 }),
    body('referral_code').optional().trim()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json(formatResponse(false, 'Validation failed', {
                errors: errors.array().map(err => ({ field: err.param, message: err.msg }))
            }));
        }

        const { full_name, email, phone, password, referral_code } = req.body;

        const existing = await User.findOne({ email: email.toLowerCase() });
        if (existing) return res.status(400).json(formatResponse(false, 'User already exists with this email'));

        let referredBy = null;
        if (referral_code) {
            referredBy = await User.findOne({ referral_code: referral_code.toUpperCase() });
            if (!referredBy) return res.status(400).json(formatResponse(false, 'Invalid referral code'));
        }

        const user = new User({
            full_name: full_name.trim(),
            email: email.toLowerCase(),
            phone: phone.trim(),
            password,
            balance: config.welcomeBonus,
            referred_by: referredBy ? referredBy._id : null,
            total_earnings: 0, referral_earnings: 0,
            withdrawable_earnings: 0, reserved_earnings: 0,
            total_deposits: 0, total_withdrawals: 0, total_investments: 0,
            account_status: 'active'
        });
        await user.save();

        if (referredBy) {
            referredBy.referral_count += 1;
            await referredBy.save();

            await Referral.create({
                referrer: referredBy._id,
                referred_user: user._id,
                referral_code: referral_code.toUpperCase(),
                status: 'pending',
                commission_percentage: config.referralCommissionPercent
            });

            await createNotification(referredBy._id, 'New Referral!',
                `${user.full_name} has signed up using your referral code! You will earn ${config.referralCommissionPercent}% commission on their first investment.`,
                'referral', '/referrals');
        }

        const token = user.generateAuthToken();

        await createNotification(user._id, 'Welcome to Liquidated!',
            'Your account has been successfully created. Start your investment journey today.',
            'success', '/dashboard');

        await createTransaction(user._id, 'bonus', config.welcomeBonus,
            'Welcome bonus for new account', 'completed');

        if (config.emailEnabled) {
            await sendEmail(user.email, 'Welcome to Liquidated!',
                `<h2>Welcome ${user.full_name}!</h2>
                <p>Your account has been successfully created.</p>
                <p><strong>Account Details:</strong></p>
                <ul>
                    <li>Email: ${user.email}</li>
                    <li>Balance: ₦${user.balance.toLocaleString()}</li>
                    <li>Referral Code: ${user.referral_code}</li>
                    <li>Referral Commission: ${config.referralCommissionPercent}% on first investment</li>
                </ul>
                <p><a href="${config.clientURL}/dashboard">Go to Dashboard</a></p>`);
        }

        res.status(201).json(formatResponse(true, 'User registered successfully', {
            user: user.toObject(),
            token
        }));
    } catch (error) {
        handleError(res, error, 'Registration failed');
    }
});

app.post('/api/auth/login', [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json(formatResponse(false, 'Validation failed'));

        const { email, password } = req.body;
        const user = await User.findOne({ email: email.toLowerCase() }).select('+password');
        if (!user) return res.status(400).json(formatResponse(false, 'Invalid credentials'));

        if (!user.is_active) return res.status(401).json(formatResponse(false, 'Account is deactivated. Please contact support.'));
        if (user.account_status === 'suspended') {
            const message = user.suspension_reason
                ? `Account suspended. Reason: ${user.suspension_reason}. Contact support.`
                : 'Account suspended. Please contact support.';
            return res.status(403).json(formatResponse(false, message));
        }
        if (user.account_status === 'rejected') return res.status(403).json(formatResponse(false, 'Account has been rejected. Please contact support.'));

        const isMatch = await user.comparePassword(password);
        if (!isMatch) return res.status(400).json(formatResponse(false, 'Invalid credentials'));

        user.last_login = new Date();
        user.last_active = new Date();

        user.login_history.push({
            ip: req.ip,
            location: req.headers['x-forwarded-for'] || req.connection.remoteAddress,
            device: req.headers['user-agent'],
            timestamp: new Date()
        });
        if (user.login_history.length > 10) user.login_history = user.login_history.slice(-10);

        await user.save();
        const token = user.generateAuthToken();

        res.json(formatResponse(true, 'Login successful', { user: user.toObject(), token }));
    } catch (error) {
        handleError(res, error, 'Login failed');
    }
});

app.post('/api/auth/change-password', auth, [
    body('currentPassword').notEmpty(),
    body('newPassword').isLength({ min: 6 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json(formatResponse(false, 'Validation failed', {
                errors: errors.array().map(e => ({ field: e.param, message: e.msg }))
            }));
        }

        const { currentPassword, newPassword } = req.body;

        const user = await User.findById(req.user._id).select('+password');
        if (!user) return res.status(404).json(formatResponse(false, 'User not found'));

        const isMatch = await user.comparePassword(currentPassword);
        if (!isMatch) {
            return res.status(400).json(formatResponse(false, 'Current password is incorrect'));
        }

        if (currentPassword === newPassword) {
            return res.status(400).json(formatResponse(false, 'New password must be different from the current password'));
        }

        user.password = newPassword;
        await user.save();

        await createNotification(user._id, 'Password Updated',
            'Your password has been changed successfully.', 'success', '/profile');

        res.json(formatResponse(true, 'Password updated successfully'));
    } catch (error) {
        handleError(res, error, 'Error changing password');
    }
});

// ==================== PROFILE ====================
app.get('/api/profile', auth, async (req, res) => {
    try {
        const userId = req.user._id;
        const user = await User.findById(userId)
            .select('-password -two_factor_secret -verification_token -password_reset_token');
        if (!user) return res.status(404).json(formatResponse(false, 'User not found'));

        const userData = user.toObject();

        const [investments, deposits, withdrawals, referrals] = await Promise.all([
            Investment.countDocuments({ user: userId }),
            Deposit.countDocuments({ user: userId, status: 'approved' }),
            Withdrawal.countDocuments({ user: userId, status: 'paid' }),
            Referral.countDocuments({ referrer: userId })
        ]);

        const activeInvestments = await Investment.find({ user: userId, status: 'active' })
            .populate('plan', 'name daily_interest');

        let dailyInterest = 0;
        let activeInvestmentValue = 0;
        activeInvestments.forEach(inv => {
            activeInvestmentValue += inv.amount || 0;
            if (inv.plan && inv.plan.daily_interest) {
                dailyInterest += (inv.amount * inv.plan.daily_interest) / 100;
            }
        });

        res.json(formatResponse(true, 'Profile retrieved successfully', {
            user: userData,
            stats: {
                balance: userData.balance || 0,
                total_earnings: userData.total_earnings || 0,
                referral_earnings: userData.referral_earnings || 0,
                withdrawable_earnings: userData.withdrawable_earnings || 0,
                reserved_earnings: userData.reserved_earnings || 0,
                available_for_withdrawal: userData.availableForWithdrawal || 0,
                daily_interest: dailyInterest,
                total_investments: investments,
                active_investments: activeInvestments.length,
                total_deposits: deposits,
                total_withdrawals: withdrawals,
                referral_count: referrals,
                confirmed_referral_count: userData.confirmed_referral_count || 0,
                active_investment_value: activeInvestmentValue,
                portfolio_value: userData.portfolioValue
            }
        }));
    } catch (error) {
        console.error('Error fetching profile:', error);
        handleError(res, error, 'Error fetching profile');
    }
});

app.put('/api/profile', auth, [
    body('full_name').optional().trim().isLength({ min: 2, max: 100 }),
    body('phone').optional().trim(),
    body('country').optional().trim(),
    body('risk_tolerance').optional().isIn(['low', 'medium', 'high']),
    body('investment_strategy').optional().isIn(['conservative', 'balanced', 'aggressive']),
    body('email_notifications').optional().isBoolean(),
    body('sms_notifications').optional().isBoolean(),
    body('investment_alerts').optional().isBoolean(),
    body('deposit_confirmations').optional().isBoolean(),
    body('marketing_messages').optional().isBoolean(),
    body('dark_mode').optional().isBoolean()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            console.error('PUT /api/profile validation errors:', errors.array());
            return res.status(400).json(formatResponse(false, 'Validation failed', {
                errors: errors.array().map(e => ({ field: e.param, message: e.msg }))
            }));
        }

        const updates = {};
        const allowed = [
            'full_name', 'phone', 'country', 'risk_tolerance', 'investment_strategy',
            'email_notifications', 'sms_notifications',
            'investment_alerts', 'deposit_confirmations', 'marketing_messages', 'dark_mode'
        ];
        allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

        const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true }).select('-password');
        if (!user) return res.status(404).json(formatResponse(false, 'User not found'));

        res.json(formatResponse(true, 'Profile updated successfully', { user }));
    } catch (error) {
        handleError(res, error, 'Error updating profile');
    }
});

// ==================== BANK DETAILS ====================
app.put('/api/profile/bank', auth, [
    body('bank_name')
        .notEmpty().withMessage('Bank name is required')
        .trim()
        .custom((value) => {
            if (!value || value.toLowerCase() === 'select bank') {
                throw new Error('Please select a valid bank from the list');
            }
            return true;
        }),
    body('account_name')
        .notEmpty().withMessage('Account holder name is required')
        .trim()
        .isLength({ min: 3, max: 100 }).withMessage('Account name must be 3–100 characters'),
    body('account_number')
        .notEmpty().withMessage('Account number is required')
        .trim()
        .matches(/^\d{10}$/).withMessage('Account number must be exactly 10 digits (0-9 only)'),
    body('bank_code').optional({ checkFalsy: true }).trim()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            console.error('PUT /api/profile/bank validation errors:', errors.array());
            console.error('   Received body:', JSON.stringify(req.body));
            console.error('   Content-Type:', req.headers['content-type']);
            return res.status(400).json(formatResponse(false, 'Validation failed', {
                errors: errors.array().map(e => ({ field: e.param, message: e.msg }))
            }));
        }

        const { bank_name, account_name, account_number, bank_code } = req.body;

        const existing = await User.findById(req.user._id);
        if (!existing) return res.status(404).json(formatResponse(false, 'User not found'));

        const isSame =
            existing.bank_details &&
            existing.bank_details.bank_name === bank_name &&
            existing.bank_details.account_name === account_name &&
            existing.bank_details.account_number === account_number;

        if (isSame) {
            return res.json(formatResponse(true, 'Bank details unchanged', {
                user: existing.toObject(),
                bank_details: existing.bank_details
            }));
        }

        const user = await User.findByIdAndUpdate(
            req.user._id,
            {
                bank_details: {
                    bank_name: bank_name.trim(),
                    account_name: account_name.trim(),
                    account_number: account_number.trim(),
                    bank_code: (bank_code || '').trim(),
                    verified: false,
                    verified_at: null,
                    last_updated: new Date()
                }
            },
            { new: true }
        ).select('-password');

        await createNotification(req.user._id, 'Bank Details Updated',
            'Your bank details have been updated successfully. Verification may take up to 1 business day.',
            'info', '/profile');

        res.json(formatResponse(true, 'Bank details updated successfully', {
            user,
            bank_details: user.bank_details
        }));
    } catch (error) {
        handleError(res, error, 'Error updating bank details');
    }
});

// ==================== PASSWORD RESET ====================
app.post('/api/auth/forgot-password', [
    body('email').isEmail().normalizeEmail()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json(formatResponse(false, 'Validation failed'));

        const { email } = req.body;
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) return res.status(404).json(formatResponse(false, 'User not found'));

        const resetToken = user.generatePasswordResetToken();
        await user.save();

        const resetUrl = `${config.clientURL}/reset-password/${resetToken}`;
        if (config.emailEnabled) {
            await sendEmail(user.email, 'Password Reset Request',
                `<h2>Password Reset Request</h2>
                <p>You requested a password reset. Click the link below to reset your password:</p>
                <p><a href="${resetUrl}">${resetUrl}</a></p>
                <p>This link will expire in 10 minutes.</p>
                <p>If you didn't request this, please ignore this email.</p>`);
        }

        res.json(formatResponse(true, 'Password reset email sent', {
            resetToken: config.emailEnabled ? 'Email sent' : resetToken
        }));
    } catch (error) {
        handleError(res, error, 'Error processing forgot password');
    }
});

app.post('/api/auth/reset-password/:token', [
    body('password').isLength({ min: 6 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json(formatResponse(false, 'Validation failed'));

        const { token } = req.params;
        const { password } = req.body;

        const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

        const user = await User.findOne({
            password_reset_token: hashedToken,
            password_reset_expires: { $gt: Date.now() }
        });
        if (!user) return res.status(400).json(formatResponse(false, 'Invalid or expired token'));

        user.password = password;
        user.password_reset_token = undefined;
        user.password_reset_expires = undefined;
        await user.save();

        await createNotification(user._id, 'Password Updated',
            'Your password has been updated successfully.', 'success', '/profile');

        res.json(formatResponse(true, 'Password reset successful'));
    } catch (error) {
        handleError(res, error, 'Error resetting password');
    }
});

// ==================== PLANS ====================
app.get('/api/plans', async (req, res) => {
    try {
        const plans = await InvestmentPlan.find({ is_active: true })
            .sort({ display_order: 1, min_amount: 1 }).lean();

        const categorized = {
            beginner: plans.filter(p => p.min_amount <= 10000 && p.risk_level === 'low'),
            intermediate: plans.filter(p => p.min_amount > 10000 && p.min_amount <= 50000 && p.risk_level === 'medium'),
            advanced: plans.filter(p => p.min_amount > 50000 && p.risk_level === 'high'),
            popular: plans.filter(p => p.is_popular === true)
        };

        res.json(formatResponse(true, 'Plans retrieved successfully', {
            plans, categorized,
            summary: {
                total_plans: plans.length,
                low_risk: plans.filter(p => p.risk_level === 'low').length,
                medium_risk: plans.filter(p => p.risk_level === 'medium').length,
                high_risk: plans.filter(p => p.risk_level === 'high').length,
                price_range: {
                    min: plans.reduce((m, p) => Math.min(m, p.min_amount), Infinity),
                    max: plans.reduce((m, p) => Math.max(m, p.max_amount || p.min_amount), 0)
                }
            }
        }));
    } catch (error) {
        handleError(res, error, 'Error fetching investment plans');
    }
});

// ==================== INVESTMENTS ====================
app.get('/api/investments', auth, async (req, res) => {
    try {
        const userId = req.user._id;
        const { status, page = 1, limit = 10 } = req.query;
        const query = { user: userId };
        if (status) query.status = status;

        const skip = (page - 1) * limit;
        const [investments, total] = await Promise.all([
            Investment.find(query)
                .populate('plan', 'name daily_interest duration total_interest raw_material icon color category')
                .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
            Investment.countDocuments(query)
        ]);

        const activeInvestments = investments.filter(i => i.status === 'active');
        const totalActiveValue = activeInvestments.reduce((s, i) => s + i.amount, 0);
        const totalEarnings = investments.reduce((s, i) => s + (i.earned_so_far || 0), 0);

        res.json(formatResponse(true, 'Investments retrieved successfully', {
            investments,
            stats: {
                total_active_value: totalActiveValue,
                total_earnings: totalEarnings,
                active_count: activeInvestments.length,
                total_count: total
            },
            pagination: {
                page: parseInt(page), limit: parseInt(limit), total,
                pages: Math.ceil(total / limit)
            }
        }));
    } catch (error) {
        handleError(res, error, 'Error fetching investments');
    }
});

app.post('/api/investments', auth, upload.single('payment_proof'), [
    body('plan_id').notEmpty(),
    body('amount').isFloat({ min: config.minInvestment }),
    body('auto_renew').optional().isBoolean()
], async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false, 'Validation failed', {
                errors: errors.array().map(e => ({ field: e.param, message: e.msg }))
            }));
        }

        const { plan_id, amount, auto_renew = false } = req.body;
        const userId = req.user._id;

        const freshUser = await User.findById(userId).session(session);
        if (!freshUser) {
            await session.abortTransaction(); session.endSession();
            return res.status(404).json(formatResponse(false, 'User not found'));
        }

        const plan = await InvestmentPlan.findById(plan_id).session(session);
        if (!plan) {
            await session.abortTransaction(); session.endSession();
            return res.status(404).json(formatResponse(false, 'Investment plan not found'));
        }

        const investmentAmount = parseFloat(amount);

        if (investmentAmount < plan.min_amount) {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false,
                `Minimum investment for ${plan.name} is ₦${plan.min_amount.toLocaleString()}`));
        }
        if (plan.max_amount && investmentAmount > plan.max_amount) {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false,
                `Maximum investment for ${plan.name} is ₦${plan.max_amount.toLocaleString()}`));
        }
        if (investmentAmount > freshUser.balance) {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false,
                `Insufficient deposit balance. Available: ₦${freshUser.balance.toLocaleString()}, Required: ₦${investmentAmount.toLocaleString()}`));
        }

        let proofUrl = null;
        let proofPublicId = null;
        if (req.file) {
            try {
                await validateFileSignature(req.file.buffer, req.file.mimetype);
                const uploadResult = await handleFileUpload(req.file, 'investment-proofs', userId);
                proofUrl = uploadResult.url;
                proofPublicId = uploadResult.public_id;
            } catch (uploadError) {
                await session.abortTransaction(); session.endSession();
                return res.status(400).json(formatResponse(false, `File upload failed: ${uploadError.message}`));
            }
        }

        const expectedEarnings = (investmentAmount * plan.total_interest) / 100;
        const dailyEarnings = (investmentAmount * plan.daily_interest) / 100;
        const endDate = new Date(Date.now() + plan.duration * 24 * 60 * 60 * 1000);
        const nextInterestDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

        const investment = new Investment({
            user: userId, plan: plan_id, amount: investmentAmount,
            status: 'active', start_date: new Date(), end_date: endDate,
            expected_earnings: expectedEarnings, daily_earnings: dailyEarnings,
            auto_renew, payment_proof_url: proofUrl, payment_proof_public_id: proofPublicId,
            payment_verified: true,
            balance_deducted: true, is_auto_approved: true,
            next_interest_date: nextInterestDate,
            total_interest_days: plan.duration
        });
        await investment.save({ session });

        freshUser.balance -= investmentAmount;
        freshUser.total_investments = (freshUser.total_investments || 0) + investmentAmount;
        freshUser.last_investment_date = new Date();
        if (!freshUser.first_investment_amount || freshUser.first_investment_amount === 0) {
            freshUser.first_investment_amount = investmentAmount;
            freshUser.first_investment_date = new Date();
        }
        await freshUser.save({ session });

        const transaction = new Transaction({
            user: userId, type: 'investment', amount: -investmentAmount,
            description: `Investment in ${plan.name} plan`, status: 'completed',
            reference: generateReference('TXN'),
            balance_before: freshUser.balance + investmentAmount,
            balance_after: freshUser.balance,
            earnings_before: freshUser.total_earnings,
            earnings_after: freshUser.total_earnings,
            referral_earnings_before: freshUser.referral_earnings,
            referral_earnings_after: freshUser.referral_earnings,
            withdrawable_before: freshUser.withdrawable_earnings,
            withdrawable_after: freshUser.withdrawable_earnings,
            related_investment: investment._id,
            metadata: {
                plan_name: plan.name, plan_duration: plan.duration,
                daily_interest: plan.daily_interest, auto_approved: true
            }
        });
        await transaction.save({ session });

        const dailyEarning = (investmentAmount * plan.daily_interest) / 100;
        investment.earned_so_far = dailyEarning;
        investment.interest_added_count = 1;
        investment.last_earning_date = new Date();
        await investment.save({ session });

        freshUser.total_earnings += dailyEarning;
        await freshUser.save({ session });

        const interestTransaction = new Transaction({
            user: userId, type: 'daily_interest', amount: dailyEarning,
            description: `First day interest from ${plan.name} investment`,
            status: 'completed', reference: generateReference('INT'),
            balance_before: freshUser.balance, balance_after: freshUser.balance,
            earnings_before: freshUser.total_earnings - dailyEarning,
            earnings_after: freshUser.total_earnings,
            related_investment: investment._id,
            metadata: {
                plan_name: plan.name, daily_interest_rate: plan.daily_interest,
                investment_amount: investmentAmount, interest_day: 1, is_first_day: true
            }
        });
        await interestTransaction.save({ session });

        await InvestmentPlan.findByIdAndUpdate(plan_id, {
            $inc: { investment_count: 1, total_invested: investmentAmount }
        }, { session });

        await session.commitTransaction();
        session.endSession();

        const userInvestmentsCount = await Investment.countDocuments({
            user: userId, status: { $in: ['active', 'completed'] }
        });
        if (userInvestmentsCount === 1 && config.referralCommissionOnFirstInvestment) {
            await awardReferralCommission(userId, investmentAmount, investment._id);
        }

        await createNotification(userId, 'Investment Successfully Created!',
            `Your investment of ₦${investmentAmount.toLocaleString()} in ${plan.name} has been automatically approved and is now active. First day interest of ₦${dailyEarning.toLocaleString()} has been credited to your earnings.`,
            'investment', '/investments');

        emitToAdmins('new-investment', {
            investment_id: investment._id, user_id: userId,
            user_name: freshUser.full_name, amount: investmentAmount,
            plan_name: plan.name, auto_approved: true,
            timestamp: new Date().toISOString()
        });

        res.status(201).json(formatResponse(true, 'Investment created and activated successfully!', {
            investment: {
                ...investment.toObject(), plan_name: plan.name,
                expected_daily_earnings: dailyEarnings,
                expected_total_earnings: expectedEarnings,
                end_date: endDate, auto_approved: true,
                first_day_interest: dailyEarning,
                next_interest_date: investment.next_interest_date
            },
            user_balance: {
                current_balance: freshUser.balance,
                withdrawable_earnings: freshUser.withdrawable_earnings
            }
        }));
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        handleError(res, error, 'Error creating investment');
    }
});

// ==================== DEPOSITS ====================
app.get('/api/deposits', auth, async (req, res) => {
    try {
        const userId = req.user._id;
        const { status, page = 1, limit = 10 } = req.query;
        const query = { user: userId };
        if (status) query.status = status;

        const skip = (page - 1) * limit;
        const [deposits, total] = await Promise.all([
            Deposit.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
            Deposit.countDocuments(query)
        ]);

        res.json(formatResponse(true, 'Deposits retrieved successfully', {
            deposits,
            stats: {
                total_deposits: deposits.filter(d => d.status === 'approved').reduce((s, d) => s + d.amount, 0),
                pending_deposits: deposits.filter(d => d.status === 'pending').reduce((s, d) => s + d.amount, 0),
                total_count: total,
                approved_count: deposits.filter(d => d.status === 'approved').length,
                pending_count: deposits.filter(d => d.status === 'pending').length
            },
            pagination: {
                page: parseInt(page), limit: parseInt(limit), total,
                pages: Math.ceil(total / limit)
            }
        }));
    } catch (error) {
        handleError(res, error, 'Error fetching deposits');
    }
});

app.post('/api/deposits', auth, (req, res) => {
    upload.single('payment_proof')(req, res, async (err) => {
        if (err) {
            console.error('Multer error in deposit:', err);
            return res.status(400).json({ success: false, message: err.message || 'File upload failed' });
        }

        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json(formatResponse(false, 'Validation failed', { errors: errors.array() }));
        }

        try {
            const { amount, payment_method } = req.body;
            const userId = req.user._id;
            const depositAmount = parseFloat(amount);

            if (isNaN(depositAmount) || depositAmount < config.minDeposit) {
                return res.status(400).json(formatResponse(false,
                    `Minimum deposit is ₦${config.minDeposit.toLocaleString()}`));
            }

            const amlCheck = await checkAmlCompliance(userId, 'deposit', depositAmount);
            if (amlCheck.flagged) {
                return res.status(400).json(formatResponse(false,
                    'Deposit flagged for review due to compliance checks. Please contact support.'));
            }

            let proofUrl = null;
            let proofPublicId = null;
            if (req.file) {
                try {
                    await validateFileSignature(req.file.buffer, req.file.mimetype);
                    const uploadResult = await handleFileUpload(req.file, 'deposit-proofs', userId);
                    proofUrl = uploadResult.url;
                    proofPublicId = uploadResult.public_id;
                } catch (uploadError) {
                    return res.status(400).json(formatResponse(false, `File upload failed: ${uploadError.message}`));
                }
            }

            const deposit = new Deposit({
                user: userId,
                amount: depositAmount,
                payment_method,
                status: 'pending',
                payment_proof_url: proofUrl,
                payment_proof_public_id: proofPublicId,
                reference: generateReference('DEP')
            });
            await deposit.save();

            await createNotification(userId, 'Deposit Request Submitted',
                `Your deposit request of ₦${depositAmount.toLocaleString()} has been submitted and is pending approval.`,
                'deposit', '/deposits');

            emitToDepositAdmins('new-deposit', {
                deposit_id: deposit._id, user_id: userId,
                amount: depositAmount, payment_method,
                has_proof: !!proofUrl, requires_approval: true
            });

            res.status(201).json(formatResponse(true, 'Deposit request submitted successfully!', {
                deposit: {
                    ...deposit.toObject(),
                    formatted_amount: `₦${depositAmount.toLocaleString()}`,
                    requires_approval: true
                }
            }));
        } catch (error) {
            console.error('Deposit creation error:', error);
            res.status(500).json(formatResponse(false, error.message || 'Error creating deposit'));
        }
    });
});

// ==================== WITHDRAWALS ====================
app.get('/api/withdrawals', auth, async (req, res) => {
    try {
        const userId = req.user._id;
        const { status, page = 1, limit = 10 } = req.query;
        const query = { user: userId };
        if (status) query.status = status;

        const skip = (page - 1) * limit;
        const [withdrawals, total] = await Promise.all([
            Withdrawal.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
            Withdrawal.countDocuments(query)
        ]);

        res.json(formatResponse(true, 'Withdrawals retrieved successfully', {
            withdrawals,
            stats: {
                total_withdrawals: withdrawals.filter(w => w.status === 'paid').reduce((s, w) => s + w.amount, 0),
                pending_withdrawals: withdrawals.filter(w => w.status === 'pending').reduce((s, w) => s + w.amount, 0),
                total_count: total,
                paid_count: withdrawals.filter(w => w.status === 'paid').length,
                pending_count: withdrawals.filter(w => w.status === 'pending').length
            },
            pagination: {
                page: parseInt(page), limit: parseInt(limit), total,
                pages: Math.ceil(total / limit)
            }
        }));
    } catch (error) {
        handleError(res, error, 'Error fetching withdrawals');
    }
});

app.post('/api/withdrawals', auth, [
    body('amount').isFloat({ min: config.minWithdrawal }),
    body('payment_method').isIn(['bank_transfer', 'crypto', 'paypal'])
], async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false, 'Validation failed', {
                errors: errors.array().map(e => ({ field: e.param, message: e.msg }))
            }));
        }

        const { amount, payment_method } = req.body;
        const userId = req.user._id;
        const withdrawalAmount = parseFloat(amount);

        const freshUser = await User.findById(userId).session(session);
        if (!freshUser) {
            await session.abortTransaction(); session.endSession();
            return res.status(404).json(formatResponse(false, 'User not found'));
        }

        if (withdrawalAmount < config.minWithdrawal) {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false,
                `Minimum withdrawal is ₦${config.minWithdrawal.toLocaleString()}`));
        }

        const availableForWithdrawal =
            (freshUser.withdrawable_earnings || 0) - (freshUser.reserved_earnings || 0);

        if (withdrawalAmount > availableForWithdrawal) {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false,
                `Insufficient earnings. Available for withdrawal: ₦${availableForWithdrawal.toLocaleString()}`));
        }

        const maxWithdrawal = availableForWithdrawal * (config.maxWithdrawalPercent / 100);
        if (withdrawalAmount > maxWithdrawal) {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false,
                `Maximum withdrawal is ${config.maxWithdrawalPercent}% of your available earnings (₦${maxWithdrawal.toLocaleString()})`));
        }

        if (withdrawalAmount >= 10000 && !freshUser.kyc_verified) {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false,
                'KYC verification is required for withdrawals of ₦10,000 and above. Please complete KYC or withdraw less than ₦10,000.'));
        }

        if (payment_method === 'bank_transfer' && (!freshUser.bank_details || !freshUser.bank_details.account_number)) {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false, 'Please update your bank details in profile settings'));
        }
        if (payment_method === 'crypto' && !freshUser.wallet_address) {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false, 'Please set your wallet address in profile settings'));
        }
        if (payment_method === 'paypal' && !freshUser.paypal_email) {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false, 'Please set your PayPal email in profile settings'));
        }

        const amlCheck = await checkAmlCompliance(userId, 'withdrawal', withdrawalAmount);
        if (amlCheck.flagged) {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false,
                'Withdrawal flagged for review due to compliance checks. Please contact support.'));
        }

        const platformFee = withdrawalAmount * (config.platformFeePercent / 100);
        const netAmount = withdrawalAmount - platformFee;

        const totalEarnings = freshUser.total_earnings || 0;
        const totalReferral = freshUser.referral_earnings || 0;
        const totalAvailable = totalEarnings + totalReferral;

        let fromEarnings = 0, fromReferral = 0;
        if (totalAvailable > 0) {
            fromEarnings = (totalEarnings / totalAvailable) * withdrawalAmount;
            fromReferral = (totalReferral / totalAvailable) * withdrawalAmount;
        }

        freshUser.reserved_earnings = (freshUser.reserved_earnings || 0) + withdrawalAmount;
        await freshUser.save({ session });

        const pendingTransaction = await createTransaction(
            userId, 'withdrawal', -withdrawalAmount,
            `Withdrawal request via ${payment_method} - Pending Admin Approval`,
            'pending',
            {
                payment_method, platform_fee: platformFee, net_amount: netAmount,
                from_earnings: fromEarnings, from_referral: fromReferral,
                requires_admin_approval: true
            }
        );
        if (!pendingTransaction.success) throw new Error('Failed to create pending transaction');

        const withdrawal = new Withdrawal({
            user: userId, amount: withdrawalAmount, payment_method,
            from_earnings: fromEarnings, from_referral: fromReferral,
            platform_fee: platformFee, net_amount: netAmount,
            status: 'pending', reference: generateReference('WDL'),
            requires_admin_approval: true, auto_approved: false,
            admin_review_status: 'pending_review',
            ...(payment_method === 'bank_transfer' && freshUser.bank_details ? { bank_details: freshUser.bank_details } : {}),
            ...(payment_method === 'crypto' ? { wallet_address: freshUser.wallet_address } : {}),
            ...(payment_method === 'paypal' ? { paypal_email: freshUser.paypal_email } : {}),
            transaction_id_ref: pendingTransaction.transaction._id
        });
        await withdrawal.save({ session });

        pendingTransaction.transaction.related_withdrawal = withdrawal._id;
        await pendingTransaction.transaction.save({ session });

        await session.commitTransaction();
        session.endSession();

        await createNotification(userId, 'Withdrawal Request Submitted',
            `Your withdrawal request of ₦${withdrawalAmount.toLocaleString()} has been submitted and is pending admin approval.`,
            'withdrawal', '/withdrawals');

        emitToWithdrawalAdmins('new-withdrawal-request', {
            withdrawal_id: withdrawal._id, user_id: userId,
            user_name: freshUser.full_name, amount: withdrawalAmount,
            payment_method, net_amount: netAmount, platform_fee: platformFee,
            timestamp: new Date().toISOString(),
            requires_immediate_attention: withdrawalAmount > 50000
        });

        emitToAdmins('new-withdrawal', {
            withdrawal_id: withdrawal._id, user_id: userId,
            amount: withdrawalAmount, payment_method, auto_approved: false
        });

        res.status(201).json(formatResponse(true,
            'Withdrawal request submitted successfully! It is now pending admin approval.', {
            withdrawal: {
                ...withdrawal.toObject(),
                formatted_amount: `₦${withdrawalAmount.toLocaleString()}`,
                formatted_net_amount: `₦${netAmount.toLocaleString()}`,
                formatted_fee: `₦${platformFee.toLocaleString()}`,
                requires_admin_approval: true,
                auto_approved: false,
                admin_review_status: 'pending_review'
            }
        }));
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        handleError(res, error, 'Error creating withdrawal');
    }
});

// ==================== TRANSACTIONS ====================
app.get('/api/transactions', auth, async (req, res) => {
    try {
        const userId = req.user._id;
        const { type, status, start_date, end_date, page = 1, limit = 100 } = req.query;
        const query = { user: userId };
        if (type) query.type = type;
        if (status) query.status = status;

        if (start_date || end_date) {
            query.createdAt = {};
            if (start_date) query.createdAt.$gte = new Date(start_date);
            if (end_date) query.createdAt.$lte = new Date(end_date);
        }

        const skip = (page - 1) * limit;
        const [transactions, total] = await Promise.all([
            Transaction.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
            Transaction.countDocuments(query)
        ]);

        const summary = {
            total_income: transactions.filter(t => t.amount > 0).reduce((s, t) => s + t.amount, 0),
            total_expenses: transactions.filter(t => t.amount < 0).reduce((s, t) => s + Math.abs(t.amount), 0),
            net_flow: transactions.reduce((s, t) => s + t.amount, 0),
            by_type: transactions.reduce((acc, t) => {
                acc[t.type] = (acc[t.type] || 0) + 1;
                return acc;
            }, {})
        };

        res.json(formatResponse(true, 'Transactions retrieved successfully', {
            transactions, summary,
            pagination: {
                page: parseInt(page), limit: parseInt(limit), total,
                pages: Math.ceil(total / limit)
            }
        }));
    } catch (error) {
        handleError(res, error, 'Error fetching transactions');
    }
});

// ==================== KYC ====================
app.post('/api/kyc', auth, upload.fields([
    { name: 'id_front', maxCount: 1 },
    { name: 'id_back', maxCount: 1 },
    { name: 'selfie_with_id', maxCount: 1 },
    { name: 'address_proof', maxCount: 1 }
]), [
    body('id_type').isIn(['national_id', 'passport', 'driver_license', 'voters_card']),
    body('id_number').notEmpty().trim(),
    body('full_name').optional().trim()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json(formatResponse(false, 'Validation failed', {
                errors: errors.array().map(e => ({ field: e.param, message: e.msg }))
            }));
        }

        const { id_type, id_number, full_name } = req.body;
        const userId = req.user._id;
        const files = req.files;

        if (!files || !files.id_front || !files.selfie_with_id) {
            return res.status(400).json(formatResponse(false, 'ID front and selfie with ID are required'));
        }

        let idFrontUrl, idBackUrl, selfieWithIdUrl, addressProofUrl;
        let idFrontPublicId, idBackPublicId, selfieWithIdPublicId, addressProofPublicId;
        try {
            await validateFileSignature(files.id_front[0].buffer, files.id_front[0].mimetype);
            await validateFileSignature(files.selfie_with_id[0].buffer, files.selfie_with_id[0].mimetype);

            const idFrontUpload = await handleFileUpload(files.id_front[0], 'kyc-documents', userId);
            idFrontUrl = idFrontUpload.url;
            idFrontPublicId = idFrontUpload.public_id;

            const selfieUpload = await handleFileUpload(files.selfie_with_id[0], 'kyc-documents', userId);
            selfieWithIdUrl = selfieUpload.url;
            selfieWithIdPublicId = selfieUpload.public_id;

            if (files.id_back && files.id_back[0]) {
                await validateFileSignature(files.id_back[0].buffer, files.id_back[0].mimetype);
                const idBackUpload = await handleFileUpload(files.id_back[0], 'kyc-documents', userId);
                idBackUrl = idBackUpload.url;
                idBackPublicId = idBackUpload.public_id;
            }
            if (files.address_proof && files.address_proof[0]) {
                await validateFileSignature(files.address_proof[0].buffer, files.address_proof[0].mimetype);
                const addressUpload = await handleFileUpload(files.address_proof[0], 'kyc-documents', userId);
                addressProofUrl = addressUpload.url;
                addressProofPublicId = addressUpload.public_id;
            }
        } catch (uploadError) {
            return res.status(400).json(formatResponse(false, `File upload failed: ${uploadError.message}`));
        }

        let kycSubmission = await KYCSubmission.findOne({ user: userId });

        const kycData = {
            user: userId, id_type, id_number,
            id_front_url: idFrontUrl, id_back_url: idBackUrl,
            selfie_with_id_url: selfieWithIdUrl, address_proof_url: addressProofUrl,
            id_front_public_id: idFrontPublicId, id_back_public_id: idBackPublicId,
            selfie_with_id_public_id: selfieWithIdPublicId, address_proof_public_id: addressProofPublicId,
            status: 'pending',
            metadata: { submitted_full_name: full_name || null }
        };

        if (kycSubmission) {
            kycSubmission = await KYCSubmission.findByIdAndUpdate(kycSubmission._id, kycData, { new: true });
        } else {
            kycSubmission = new KYCSubmission(kycData);
            await kycSubmission.save();
        }

        await User.findByIdAndUpdate(userId, {
            kyc_status: 'pending', kyc_submitted_at: new Date()
        });

        await createNotification(userId, 'KYC Submitted',
            'Your KYC documents have been submitted successfully. Verification typically takes 24-48 hours.',
            'kyc', '/kyc');

        emitToAdmins('new-kyc', { kyc_id: kycSubmission._id, user_id: userId, id_type });

        res.status(201).json(formatResponse(true, 'KYC submitted successfully!', { kyc: kycSubmission }));
    } catch (error) {
        handleError(res, error, 'Error submitting KYC');
    }
});

app.get('/api/kyc/status', auth, async (req, res) => {
    try {
        const userId = req.user._id;
        const kycSubmission = await KYCSubmission.findOne({ user: userId });
        const user = await User.findById(userId);

        res.json(formatResponse(true, 'KYC status retrieved', {
            kyc_status: user.kyc_status,
            kyc_verified: user.kyc_verified,
            kyc_submitted_at: user.kyc_submitted_at,
            kyc_verified_at: user.kyc_verified_at,
            kyc_submission: kycSubmission ? {
                id_type: kycSubmission.id_type,
                id_number: kycSubmission.id_number,
                status: kycSubmission.status,
                submitted_at: kycSubmission.createdAt,
                reviewed_at: kycSubmission.reviewed_at,
                rejection_reason: kycSubmission.rejection_reason,
                id_front_url: kycSubmission.id_front_url,
                id_back_url: kycSubmission.id_back_url,
                selfie_with_id_url: kycSubmission.selfie_with_id_url,
                address_proof_url: kycSubmission.address_proof_url,
                id_front_public_id: kycSubmission.id_front_public_id,
                id_back_public_id: kycSubmission.id_back_public_id,
                selfie_with_id_public_id: kycSubmission.selfie_with_id_public_id,
                address_proof_public_id: kycSubmission.address_proof_public_id
            } : null
        }));
    } catch (error) {
        handleError(res, error, 'Error fetching KYC status');
    }
});

// ==================== SUPPORT ====================
app.post('/api/support', auth, upload.array('attachments', 5), [
    body('subject').notEmpty().trim().isLength({ min: 5, max: 200 }),
    body('message').notEmpty().trim().isLength({ min: 10, max: 5000 }),
    body('category').optional().isIn(['general', 'technical', 'investment', 'withdrawal', 'deposit', 'kyc', 'account', 'other']),
    body('priority').optional().isIn(['low', 'medium', 'high', 'urgent'])
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json(formatResponse(false, 'Validation failed', {
                errors: errors.array().map(e => ({ field: e.param, message: e.msg }))
            }));
        }

        const { subject, message, category = 'general', priority = 'medium' } = req.body;
        const userId = req.user._id;
        const files = req.files || [];

        const attachments = [];
        for (const file of files) {
            try {
                await validateFileSignature(file.buffer, file.mimetype);
                const uploadResult = await handleFileUpload(file, 'support-attachments', userId);
                attachments.push({
                    filename: uploadResult.filename,
                    url: uploadResult.url,
                    public_id: uploadResult.public_id,
                    size: uploadResult.size,
                    mime_type: uploadResult.mimeType
                });
            } catch (uploadError) {
                console.error('Error uploading attachment:', uploadError);
            }
        }

        const ticketId = `TKT${Date.now()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

        const supportTicket = new SupportTicket({
            user: userId, ticket_id: ticketId, subject, message,
            category, priority, attachments, status: 'open'
        });
        await supportTicket.save();

        await createNotification(userId, 'Support Ticket Created',
            `Your support ticket #${ticketId} has been created successfully. We will respond within 24 hours.`,
            'info', `/support/ticket/${ticketId}`);

        emitToAdmins('new-support-ticket', { ticket_id: ticketId, user_id: userId, subject, priority });

        res.status(201).json(formatResponse(true, 'Support ticket created successfully!', {
            ticket: { ...supportTicket.toObject(), ticket_id: ticketId }
        }));
    } catch (error) {
        handleError(res, error, 'Error creating support ticket');
    }
});

app.get('/api/support/tickets', auth, async (req, res) => {
    try {
        const userId = req.user._id;
        const { status, page = 1, limit = 10 } = req.query;
        const query = { user: userId };
        if (status) query.status = status;

        const skip = (page - 1) * limit;
        const [tickets, total] = await Promise.all([
            SupportTicket.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
            SupportTicket.countDocuments(query)
        ]);

        res.json(formatResponse(true, 'Support tickets retrieved successfully', {
            tickets,
            stats: {
                total_tickets: total,
                open_tickets: tickets.filter(t => t.status === 'open').length,
                resolved_tickets: tickets.filter(t => t.status === 'resolved').length
            },
            pagination: {
                page: parseInt(page), limit: parseInt(limit), total,
                pages: Math.ceil(total / limit)
            }
        }));
    } catch (error) {
        handleError(res, error, 'Error fetching support tickets');
    }
});

// ==================== REFERRALS (20%) ====================
app.get('/api/referrals/stats', auth, async (req, res) => {
    try {
        const userId = req.user._id;
        const referrals = await Referral.find({ referrer: userId })
            .populate('referred_user', 'full_name email createdAt balance first_investment_amount')
            .sort({ createdAt: -1 }).lean();

        const user = await User.findById(userId);

        let totalFirstInvestmentCommission = 0;
        referrals.forEach(ref => {
            if (ref.first_investment_commission_paid && ref.first_investment_amount) {
                totalFirstInvestmentCommission += ref.first_investment_amount * (config.referralCommissionPercent / 100);
            }
        });

        const confirmed = referrals.filter(r => r.first_investment_commission_paid).length;

        res.json(formatResponse(true, 'Referral stats retrieved successfully', {
            stats: {
                total_referrals: referrals.length,
                confirmed_referrals: confirmed,
                pending_referrals: referrals.length - confirmed,
                active_referrals: referrals.filter(r => r.status === 'active').length,
                referral_earnings: user.referral_earnings || 0,
                first_investment_commission: totalFirstInvestmentCommission,
                referral_code: user.referral_code,
                referral_link: `${config.clientURL}/register?ref=${user.referral_code}`,
                commission_rate: `${config.referralCommissionPercent}% (First investment only)`
            },
            referrals: referrals.slice(0, 10).map(ref => ({
                ...ref,
                first_investment_commission: ref.first_investment_amount
                    ? ref.first_investment_amount * (config.referralCommissionPercent / 100)
                    : 0
            }))
        }));
    } catch (error) {
        handleError(res, error, 'Error fetching referral stats');
    }
});

// ==================== AWARDS ROUTES ====================
app.get('/api/awards/tiers', async (req, res) => {
    try {
        const tiers = await AwardTier.find({ is_active: true }).sort({ referrals_required: 1 }).lean();
        res.set('Cache-Control', 'public, max-age=3600');
        res.json(formatResponse(true, 'Award tiers retrieved', { tiers }));
    } catch (err) {
        handleError(res, err, 'Error fetching award tiers');
    }
});

app.get('/api/awards/status', auth, async (req, res) => {
    try {
        const status = await computeUserAwardStatus(req.user._id);
        res.json(formatResponse(true, 'Award status retrieved', status));
    } catch (err) {
        handleError(res, err, 'Error computing award status');
    }
});

app.post('/api/awards/claim/:tierNumber', auth, async (req, res) => {
    try {
        const tierNumber = parseInt(req.params.tierNumber, 10);
        if (isNaN(tierNumber)) return res.status(400).json(formatResponse(false, 'Invalid tier number'));

        const tier = await AwardTier.findOne({ tier_number: tierNumber, is_active: true });
        if (!tier) return res.status(404).json(formatResponse(false, 'Tier not found'));

        const status = await computeUserAwardStatus(req.user._id);
        if (status.confirmed_referrals < tier.referrals_required) {
            return res.status(400).json(formatResponse(false,
                `You need ${tier.referrals_required} confirmed referrals to claim this tier. You currently have ${status.confirmed_referrals}.`));
        }

        const existing = await AwardClaim.findOne({ user: req.user._id, tier_number: tierNumber });
        if (existing) return res.status(400).json(formatResponse(false, 'You have already claimed this tier.'));

        if (tierNumber >= 5 && !req.user.kyc_verified) {
            return res.status(400).json(formatResponse(false, 'KYC verification is required for tiers 5 and above.'));
        }

        const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
        const recent = await AwardClaim.countDocuments({ user: req.user._id, createdAt: { $gte: hourAgo } });
        if (recent >= 3) return res.status(429).json(formatResponse(false, 'Rate limit: maximum 3 award claims per hour.'));

        const { delivery_details } = req.body || {};
        if (!delivery_details || !delivery_details.full_name || !delivery_details.phone ||
            !delivery_details.address_line || !delivery_details.city || !delivery_details.state) {
            return res.status(400).json(formatResponse(false, 'Incomplete delivery details: full_name, phone, address_line, city, and state are required.'));
        }

        const claim = await AwardClaim.create({
            user: req.user._id,
            tier: tier._id,
            tier_number: tierNumber,
            referrals_at_claim: status.confirmed_referrals,
            status: 'claimed',
            delivery_details
        });

        await createNotification(req.user._id,
            `Award Claim Submitted — ${tier.title}`,
            `Your claim for "${tier.reward_name}" has been submitted and is now under review. Our team will contact you shortly.`,
            'success', '/awards',
            { award_tier_number: tierNumber, claim_id: String(claim._id) });

        emitToAwardAdmins('award-claim-created', {
            claim_id: claim._id,
            user_id: req.user._id,
            user_name: req.user.full_name,
            user_email: req.user.email,
            tier_title: tier.title,
            tier_number: tierNumber,
            reward_name: tier.reward_name,
            estimated_value_ngn: tier.estimated_value_ngn,
            timestamp: new Date().toISOString()
        });

        await AdminAudit.create({
            admin_id: null, actor: 'system',
            action: 'award_claim_created', target_type: 'award_claim', target_id: claim._id,
            details: {
                user_id: req.user._id, tier_number: tierNumber,
                tier_title: tier.title, reward_name: tier.reward_name,
                referrals_at_claim: status.confirmed_referrals
            },
            ip_address: req.ip, user_agent: req.headers['user-agent']
        });

        res.status(201).json(formatResponse(true, 'Award claim submitted successfully', { claim }));
    } catch (err) {
        handleError(res, err, 'Error submitting award claim');
    }
});

app.get('/api/awards/claims', auth, async (req, res) => {
    try {
        const claims = await AwardClaim.find({ user: req.user._id })
            .populate('tier', 'tier_number title reward_name reward_icon image_url accent_color estimated_value_ngn reward_category')
            .sort({ createdAt: -1 }).lean();
        res.json(formatResponse(true, 'Claims retrieved', { claims }));
    } catch (err) {
        handleError(res, err, 'Error fetching claims');
    }
});

app.get('/api/awards/leaderboard', async (req, res) => {
    try {
        const rows = await Referral.aggregate([
            { $match: { first_investment_commission_paid: true } },
            { $group: { _id: '$referrer', confirmed: { $sum: 1 } } },
            { $sort: { confirmed: -1 } },
            { $limit: 100 },
            { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'u' } },
            { $unwind: '$u' },
            { $match: { 'u.account_status': 'active' } },
            {
                $project: {
                    _id: 0,
                    userId: '$_id',
                    name: '$u.full_name',
                    confirmed: 1,
                    referral_code: '$u.referral_code'
                }
            }
        ]);

        const tiers = await AwardTier.find().sort({ referrals_required: 1 }).lean();

        const mapped = rows.map((r, i) => {
            let tier = null;
            for (const t of tiers) {
                if (r.confirmed >= t.referrals_required) tier = t;
                else break;
            }
            return {
                rank: i + 1,
                user_id: r.userId,
                name: r.name,
                confirmed: r.confirmed,
                referral_code: r.referral_code,
                tier: tier ? {
                    tier_number: tier.tier_number,
                    title: tier.title,
                    reward_icon: tier.reward_icon,
                    accent_color: tier.accent_color
                } : null
            };
        });

        res.set('Cache-Control', 'public, max-age=1800');
        res.json(formatResponse(true, 'Leaderboard retrieved', { leaderboard: mapped }));
    } catch (err) {
        handleError(res, err, 'Error fetching leaderboard');
    }
});

// ==================== NOTIFICATIONS ====================
app.get('/api/notifications', auth, async (req, res) => {
    try {
        const userId = req.user._id;
        const { unread_only = false, page = 1, limit = 20 } = req.query;
        const query = { user: userId };
        if (unread_only === 'true') query.is_read = false;

        const skip = (page - 1) * limit;
        const [notifications, total, unreadCount] = await Promise.all([
            Notification.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
            Notification.countDocuments(query),
            Notification.countDocuments({ user: userId, is_read: false })
        ]);

        res.json(formatResponse(true, 'Notifications retrieved successfully', {
            notifications, unread_count: unreadCount,
            pagination: {
                page: parseInt(page), limit: parseInt(limit), total,
                pages: Math.ceil(total / limit)
            }
        }));
    } catch (error) {
        handleError(res, error, 'Error fetching notifications');
    }
});

app.post('/api/notifications/:id/read', auth, async (req, res) => {
    try {
        const notification = await Notification.findOneAndUpdate(
            { _id: req.params.id, user: req.user._id },
            { is_read: true }, { new: true }
        );
        if (!notification) return res.status(404).json(formatResponse(false, 'Notification not found'));
        res.json(formatResponse(true, 'Notification marked as read', { notification }));
    } catch (error) {
        handleError(res, error, 'Error marking notification as read');
    }
});

app.post('/api/notifications/read-all', auth, async (req, res) => {
    try {
        await Notification.updateMany({ user: req.user._id, is_read: false }, { is_read: true });
        res.json(formatResponse(true, 'All notifications marked as read'));
    } catch (error) {
        handleError(res, error, 'Error marking notifications as read');
    }
});

// ==================== UPLOAD ====================
app.post('/api/upload', auth, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json(formatResponse(false, 'No file uploaded'));

        await validateFileSignature(req.file.buffer, req.file.mimetype);

        const userId = req.user._id;
        const folder = (req.body.folder || 'general').replace(/[^a-z0-9_-]/gi, '');
        const uploadResult = await handleFileUpload(req.file, folder, userId);

        res.json(formatResponse(true, 'File uploaded successfully', {
            fileUrl: uploadResult.url,
            fileName: uploadResult.filename,
            originalName: uploadResult.originalName,
            size: uploadResult.size,
            mimeType: uploadResult.mimeType,
            public_id: uploadResult.public_id,
            is_private: uploadResult.is_private,
            folder, uploadedAt: new Date()
        }));
    } catch (error) {
        handleError(res, error, 'Error uploading file');
    }
});

// ==================== GDPR / DATA EXPORT ====================
app.get('/api/account/export', auth, async (req, res) => {
    try {
        const userId = req.user._id;

        const [user, investments, deposits, withdrawals, transactions, referrals, kyc, claims, notifications] = await Promise.all([
            User.findById(userId).select('-password -two_factor_secret -verification_token -password_reset_token').lean(),
            Investment.find({ user: userId }).lean(),
            Deposit.find({ user: userId }).lean(),
            Withdrawal.find({ user: userId }).lean(),
            Transaction.find({ user: userId }).sort({ createdAt: -1 }).lean(),
            Referral.find({ referrer: userId }).lean(),
            KYCSubmission.findOne({ user: userId }).lean(),
            AwardClaim.find({ user: userId }).lean(),
            Notification.find({ user: userId }).sort({ createdAt: -1 }).limit(500).lean()
        ]);

        const exportData = {
            exported_at: new Date().toISOString(),
            export_version: '1.0',
            user, investments, deposits, withdrawals, transactions,
            referrals, kyc, award_claims: claims, notifications
        };

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="liquidated-export-${userId}-${Date.now()}.json"`);
        res.send(JSON.stringify(exportData, null, 2));
    } catch (error) {
        handleError(res, error, 'Error exporting account data');
    }
});

// ==================== CRON JOBS ====================
cron.schedule('0 * * * *', async () => {
    try { await calculateDailyInterest(); }
    catch (err) { console.error('Hourly interest cron error:', err); }
});

cron.schedule('*/5 * * * *', async () => {
    try {
        const now = new Date();
        const count = await Investment.countDocuments({
            status: 'active',
            end_date: { $gt: now },
            next_interest_date: { $lte: now }
        });
        if (count > 0) {
            console.log(`💰 ${count} investments need interest`);
            await calculateDailyInterest();
        }
    } catch (error) {
        console.error('Quick check error:', error);
    }
});

cron.schedule('30 * * * *', async () => {
    await withCronLock('investmentCompletion', config.cronLockTTL.investmentCompletion, async () => {
        try {
            console.log('🔄 Checking completed investments...');
            const completed = await Investment.find({
                status: 'active',
                end_date: { $lte: new Date() }
            }).populate('user plan');

            let count = 0;
            for (const inv of completed) {
                inv.status = 'completed';
                await inv.save();
                await createNotification(inv.user._id, 'Investment Completed',
                    `Your investment in ${inv.plan.name} has completed. Total earnings: ₦${inv.earned_so_far.toLocaleString()}`,
                    'investment', '/investments');
                count++;
            }
            console.log(`✅ ${count} investments marked completed`);
            return { count };
        } catch (error) {
            console.error('❌ Investment completion error:', error);
            throw error;
        }
    }).catch(err => console.error('investmentCompletion cron failed:', err));
});

if (config.autoCorrectEarnings) {
    cron.schedule(config.autoCorrectCronSchedule, async () => {
        try { await autoCorrectAllUsersEarnings(); }
        catch (err) { console.error('autoCorrect cron failed:', err); }
    });
}

// ==================== ADMIN ====================
app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
    try {
        const [
            totalUsers, newUsersToday, newUsersWeek,
            totalInvestments, activeInvestments,
            totalDeposits, totalWithdrawals,
            pendingInvestments, pendingDeposits, pendingWithdrawals, pendingKYC, amlFlags,
            pendingAwardClaims, fulfilledAwardClaims
        ] = await Promise.all([
            User.countDocuments({}),
            User.countDocuments({ createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) } }),
            User.countDocuments({ createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }),
            Investment.countDocuments({}),
            Investment.countDocuments({ status: 'active' }),
            Deposit.countDocuments({ status: 'approved' }),
            Withdrawal.countDocuments({ status: 'paid' }),
            Investment.countDocuments({ status: 'pending' }),
            Deposit.countDocuments({ status: 'pending' }),
            Withdrawal.countDocuments({ status: 'pending' }),
            KYCSubmission.countDocuments({ status: 'pending' }),
            AmlMonitoring.countDocuments({ status: 'pending_review' }),
            AwardClaim.countDocuments({ status: { $in: ['claimed', 'under_review', 'approved'] } }),
            AwardClaim.countDocuments({ status: 'fulfilled' })
        ]);

        const earningsResult = await Investment.aggregate([
            { $match: { status: 'active' } },
            { $group: { _id: null, total: { $sum: '$earned_so_far' } } }
        ]);
        const totalEarnings = earningsResult[0]?.total || 0;

        const userFinancials = await User.aggregate([
            { $match: { role: { $ne: 'super_admin' } } },
            {
                $group: {
                    _id: null,
                    total_balance: { $sum: '$balance' },
                    total_earnings: { $sum: '$total_earnings' },
                    total_referral_earnings: { $sum: '$referral_earnings' },
                    total_reserved: { $sum: '$reserved_earnings' },
                    total_withdrawn: { $sum: '$total_withdrawn' },
                    total_deposits: { $sum: '$total_deposits' },
                    total_withdrawals: { $sum: '$total_withdrawals' },
                    total_investments: { $sum: '$total_investments' }
                }
            }
        ]);

        const fs = userFinancials[0] || {
            total_balance: 0, total_earnings: 0, total_referral_earnings: 0,
            total_reserved: 0, total_withdrawn: 0, total_deposits: 0,
            total_withdrawals: 0, total_investments: 0
        };

        const totalPortfolio = (fs.total_balance || 0) + (fs.total_earnings || 0) + (fs.total_referral_earnings || 0);

        const accountStatusStats = await User.aggregate([
            { $match: { role: { $ne: 'super_admin' } } },
            { $group: { _id: '$account_status', count: { $sum: 1 } } }
        ]);

        res.json(formatResponse(true, 'Admin dashboard stats retrieved successfully', {
            stats: {
                overview: {
                    total_users: totalUsers, new_users_today: newUsersToday,
                    new_users_week: newUsersWeek, total_investments: totalInvestments,
                    active_investments: activeInvestments, total_deposits: totalDeposits,
                    total_withdrawals: totalWithdrawals, total_earnings: totalEarnings,
                    total_portfolio_value: totalPortfolio
                },
                user_financials: {
                    total_user_balance: fs.total_balance,
                    total_user_earnings: fs.total_earnings,
                    total_user_referral_earnings: fs.total_referral_earnings,
                    total_user_reserved: fs.total_reserved,
                    total_user_withdrawn: fs.total_withdrawn,
                    total_user_deposits: fs.total_deposits,
                    total_user_withdrawals: fs.total_withdrawals,
                    total_user_investments: fs.total_investments
                },
                pending_actions: {
                    pending_investments: pendingInvestments,
                    pending_deposits: pendingDeposits,
                    pending_withdrawals: pendingWithdrawals,
                    pending_kyc: pendingKYC,
                    aml_flags: amlFlags,
                    pending_award_claims: pendingAwardClaims,
                    fulfilled_award_claims: fulfilledAwardClaims,
                    total_pending: pendingInvestments + pendingDeposits + pendingWithdrawals + pendingKYC + amlFlags + pendingAwardClaims
                },
                account_status: accountStatusStats.reduce((acc, s) => { acc[s._id] = s.count; return acc; }, {})
            },
            quick_links: {
                pending_investments: '/api/admin/pending-investments',
                pending_deposits: '/api/admin/pending-deposits',
                pending_withdrawals: '/api/admin/pending-withdrawals',
                pending_kyc: '/api/admin/pending-kyc',
                aml_flags: '/api/admin/aml-flags',
                award_claims: '/api/admin/awards/claims',
                all_users: '/api/admin/users',
                suspended_users: '/api/admin/users?account_status=suspended',
                rejected_users: '/api/admin/users?account_status=rejected',
                recalc_earnings: '/api/admin/users/:id/recalculate-earnings'
            }
        }));
    } catch (error) {
        handleError(res, error, 'Error fetching admin dashboard stats');
    }
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
    try {
        const { page = 1, limit = 20, status, role, kyc_status, account_status, search } = req.query;
        const query = {};
        if (status === 'active') query.is_active = true;
        if (status === 'inactive') query.is_active = false;
        if (role) query.role = role;
        if (kyc_status) query.kyc_status = kyc_status;
        if (account_status) query.account_status = account_status;
        if (search) {
            query.$or = [
                { full_name: { $regex: search, $options: 'i' } },
                { email: { $regex: search, $options: 'i' } },
                { phone: { $regex: search, $options: 'i' } },
                { referral_code: { $regex: search, $options: 'i' } }
            ];
        }

        const skip = (page - 1) * limit;
        const [users, total] = await Promise.all([
            User.find(query)
                .select('-password -two_factor_secret -verification_token -password_reset_token')
                .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
            User.countDocuments(query)
        ]);

        const enhancedUsers = users.map(u => ({
            ...u,
            portfolio_value: (u.balance || 0) + (u.total_earnings || 0) + (u.referral_earnings || 0),
            available_for_withdrawal: Math.max(0, (u.withdrawable_earnings || 0) - (u.reserved_earnings || 0)),
            financial_summary: {
                balance: u.balance || 0,
                total_earnings: u.total_earnings || 0,
                referral_earnings: u.referral_earnings || 0,
                reserved_earnings: u.reserved_earnings || 0,
                total_withdrawn: u.total_withdrawn || 0,
                total_deposits: u.total_deposits || 0,
                total_withdrawals: u.total_withdrawals || 0,
                total_investments: u.total_investments || 0
            }
        }));

        res.json(formatResponse(true, 'Users retrieved successfully', {
            users: enhancedUsers,
            pagination: {
                page: parseInt(page), limit: parseInt(limit), total,
                pages: Math.ceil(total / limit)
            },
            summary: {
                total_users: total,
                active_users: enhancedUsers.filter(u => u.is_active).length,
                suspended_users: enhancedUsers.filter(u => u.account_status === 'suspended').length,
                rejected_users: enhancedUsers.filter(u => u.account_status === 'rejected').length,
                verified_users: enhancedUsers.filter(u => u.kyc_verified).length,
                total_balance: enhancedUsers.reduce((s, u) => s + (u.balance || 0), 0),
                total_earnings: enhancedUsers.reduce((s, u) => s + (u.total_earnings || 0), 0),
                total_referral_earnings: enhancedUsers.reduce((s, u) => s + (u.referral_earnings || 0), 0),
                total_withdrawn: enhancedUsers.reduce((s, u) => s + (u.total_withdrawn || 0), 0),
                total_withdrawable: enhancedUsers.reduce((s, u) => s + (u.withdrawable_earnings || 0), 0)
            }
        }));
    } catch (error) {
        handleError(res, error, 'Error fetching users');
    }
});

app.get('/api/admin/users/:id', adminAuth, async (req, res) => {
    try {
        const userId = req.params.id;
        const user = await User.findById(userId)
            .select('-password -two_factor_secret -verification_token -password_reset_token');
        if (!user) return res.status(404).json(formatResponse(false, 'User not found'));

        const [investments, deposits, withdrawals, referrals, transactions, awardClaims] = await Promise.all([
            Investment.find({ user: userId }).populate('plan', 'name daily_interest duration').sort({ createdAt: -1 }).lean(),
            Deposit.find({ user: userId }).sort({ createdAt: -1 }).lean(),
            Withdrawal.find({ user: userId }).sort({ createdAt: -1 }).lean(),
            Referral.find({ referrer: userId }).populate('referred_user', 'full_name email createdAt').sort({ createdAt: -1 }).lean(),
            Transaction.find({ user: userId }).sort({ createdAt: -1 }).limit(50).lean(),
            AwardClaim.find({ user: userId }).populate('tier', 'tier_number title reward_name reward_icon').sort({ createdAt: -1 }).lean()
        ]);

        res.json(formatResponse(true, 'User details retrieved successfully', {
            user: user.toObject(),
            financial_summary: {
                current_balance: user.balance || 0,
                total_earnings: user.total_earnings || 0,
                referral_earnings: user.referral_earnings || 0,
                reserved_earnings: user.reserved_earnings || 0,
                total_withdrawn: user.total_withdrawn || 0,
                withdrawable_earnings: user.withdrawable_earnings || 0,
                available_for_withdrawal: user.availableForWithdrawal,
                total_deposits: user.total_deposits || 0,
                total_withdrawals: user.total_withdrawals || 0,
                total_investments: user.total_investments || 0,
                portfolio_value: (user.balance || 0) + (user.total_earnings || 0) + (user.referral_earnings || 0)
            },
            stats: {
                total_investments: investments.length,
                total_deposits: deposits.length,
                total_withdrawals: withdrawals.length,
                total_referrals: referrals.length,
                total_transactions: transactions.length,
                total_award_claims: awardClaims.length
            },
            preview: {
                investments: investments.slice(0, 5),
                deposits: deposits.slice(0, 5),
                withdrawals: withdrawals.slice(0, 5),
                referrals: referrals.slice(0, 5),
                transactions: transactions.slice(0, 10),
                award_claims: awardClaims
            }
        }));
    } catch (error) {
        console.error('Error fetching user details:', error);
        handleError(res, error, 'Error fetching user information');
    }
});

app.post('/api/admin/users/:id/suspend', adminAuth, [
    body('reason').notEmpty().trim().isLength({ min: 5, max: 500 }),
    body('duration_days').optional().isInt({ min: 1, max: 365 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json(formatResponse(false, 'Validation failed'));

        const userId = req.params.id;
        const adminId = req.user._id;
        const { reason, duration_days } = req.body;

        const user = await User.findById(userId);
        if (!user) return res.status(404).json(formatResponse(false, 'User not found'));
        if (user.role === 'super_admin') return res.status(403).json(formatResponse(false, 'Cannot suspend super admin'));
        if (user.role === 'admin' && req.user.role !== 'super_admin') {
            return res.status(403).json(formatResponse(false, 'Only super admin can suspend other admins'));
        }

        user.suspendAccount(reason, adminId, duration_days);
        await user.save();

        await AdminAudit.create({
            admin_id: adminId, actor: 'admin',
            action: 'suspend_user', target_type: 'user', target_id: userId,
            details: { reason, duration_days: duration_days || 'indefinite', user_email: user.email },
            ip_address: req.ip, user_agent: req.headers['user-agent']
        });

        await createNotification(userId, 'Account Suspended',
            `Your account has been suspended. Reason: ${reason}${duration_days ? ` Duration: ${duration_days} days` : ''}. Please contact support for more information.`,
            'error', '/support');

        emitToAdmins('user-suspended', {
            user_id: userId, user_email: user.email,
            suspended_by: adminId, reason, duration_days
        });

        res.json(formatResponse(true, 'User account suspended successfully', {
            user: {
                id: user._id, email: user.email,
                account_status: user.account_status,
                suspension_reason: user.suspension_reason,
                suspension_date: user.suspension_date,
                suspension_end_date: user.suspension_end_date
            }
        }));
    } catch (error) {
        handleError(res, error, 'Error suspending user account');
    }
});

app.post('/api/admin/users/:id/activate', adminAuth, async (req, res) => {
    try {
        const userId = req.params.id;
        const adminId = req.user._id;

        const user = await User.findById(userId);
        if (!user) return res.status(404).json(formatResponse(false, 'User not found'));
        if (user.account_status !== 'suspended') return res.status(400).json(formatResponse(false, 'User account is not suspended'));

        user.activateAccount();
        await user.save();

        await AdminAudit.create({
            admin_id: adminId, actor: 'admin',
            action: 'activate_user', target_type: 'user', target_id: userId,
            details: { user_email: user.email, previous_status: 'suspended' },
            ip_address: req.ip, user_agent: req.headers['user-agent']
        });

        await createNotification(userId, 'Account Activated',
            'Your account has been activated. You can now access all features.',
            'success', '/dashboard');

        emitToAdmins('user-activated', { user_id: userId, user_email: user.email, activated_by: adminId });

        res.json(formatResponse(true, 'User account activated successfully', {
            user: { id: user._id, email: user.email, account_status: user.account_status, is_active: user.is_active }
        }));
    } catch (error) {
        handleError(res, error, 'Error activating user account');
    }
});

app.post('/api/admin/users/:id/reject', adminAuth, [
    body('reason').notEmpty().trim().isLength({ min: 5, max: 500 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json(formatResponse(false, 'Validation failed'));

        const userId = req.params.id;
        const adminId = req.user._id;
        const { reason } = req.body;

        const user = await User.findById(userId);
        if (!user) return res.status(404).json(formatResponse(false, 'User not found'));
        if (user.role === 'super_admin') return res.status(403).json(formatResponse(false, 'Cannot reject super admin'));
        if (user.role === 'admin' && req.user.role !== 'super_admin') {
            return res.status(403).json(formatResponse(false, 'Only super admin can reject other admins'));
        }

        user.rejectAccount(reason, adminId);
        await user.save();

        await AdminAudit.create({
            admin_id: adminId, actor: 'admin',
            action: 'reject_user', target_type: 'user', target_id: userId,
            details: { reason, user_email: user.email },
            ip_address: req.ip, user_agent: req.headers['user-agent']
        });

        await createNotification(userId, 'Account Rejected',
            `Your account has been rejected. Reason: ${reason}. Please contact support for more information.`,
            'error', '/support');

        emitToAdmins('user-rejected', { user_id: userId, user_email: user.email, rejected_by: adminId, reason });

        res.json(formatResponse(true, 'User account rejected successfully', {
            user: {
                id: user._id, email: user.email,
                account_status: user.account_status,
                suspension_reason: user.suspension_reason,
                suspension_date: user.suspension_date
            }
        }));
    } catch (error) {
        handleError(res, error, 'Error rejecting user account');
    }
});

app.post('/api/admin/users/:id/update-balance', adminAuth, [
    body('amount').isFloat(),
    body('type').isIn(['add', 'subtract', 'set']),
    body('reason').notEmpty().trim().isLength({ min: 5, max: 500 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json(formatResponse(false, 'Validation failed'));

        const userId = req.params.id;
        const adminId = req.user._id;
        const { amount, type, reason } = req.body;

        const user = await User.findById(userId);
        if (!user) return res.status(404).json(formatResponse(false, 'User not found'));

        let newBalance = user.balance || 0;
        let transactionAmount = 0;
        let description = '';

        switch (type) {
            case 'add':
                newBalance += parseFloat(amount);
                transactionAmount = parseFloat(amount);
                description = `Admin added balance: ${reason}`;
                break;
            case 'subtract':
                newBalance = Math.max(0, newBalance - parseFloat(amount));
                transactionAmount = -parseFloat(amount);
                description = `Admin deducted balance: ${reason}`;
                break;
            case 'set':
                newBalance = parseFloat(amount);
                transactionAmount = parseFloat(amount) - (user.balance || 0);
                description = `Admin set balance: ${reason}`;
                break;
        }

        const oldBalance = user.balance;
        user.balance = newBalance;
        await user.save();

        if (transactionAmount !== 0) {
            await createTransaction(userId, 'bonus', transactionAmount, description, 'completed', {
                admin_id: adminId, reason,
                balance_before: oldBalance, balance_after: user.balance,
                admin_action: true
            });
        }

        await AdminAudit.create({
            admin_id: adminId, actor: 'admin',
            action: 'update_balance', target_type: 'user', target_id: userId,
            details: {
                amount: parseFloat(amount), type, reason,
                old_balance: oldBalance, new_balance: user.balance,
                user_email: user.email
            },
            ip_address: req.ip, user_agent: req.headers['user-agent']
        });

        await createNotification(userId, 'Balance Updated',
            `Your balance has been updated by admin. New balance: ₦${newBalance.toLocaleString()}. Reason: ${reason}`,
            'info', '/profile');

        res.json(formatResponse(true, 'User balance updated successfully', {
            user: {
                id: user._id, email: user.email,
                old_balance: oldBalance, new_balance: user.balance,
                transaction_amount: transactionAmount
            }
        }));
    } catch (error) {
        handleError(res, error, 'Error updating user balance');
    }
});

app.post('/api/admin/users/:id/recalculate-earnings', adminAuth, async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const userId = req.params.id;

        const userBefore = await User.findById(userId).session(session);
        if (!userBefore) {
            await session.abortTransaction(); session.endSession();
            return res.status(404).json(formatResponse(false, 'User not found'));
        }

        const recalcResult = await recalculateUserEarnings(userId, session);

        await AdminAudit.create([{
            admin_id: req.user._id, actor: 'admin',
            action: 'recalculate_earnings', target_type: 'user', target_id: userId,
            details: {
                before: {
                    total_earnings: userBefore.total_earnings,
                    referral_earnings: userBefore.referral_earnings,
                    total_withdrawn: userBefore.total_withdrawn,
                    withdrawable_earnings: userBefore.withdrawable_earnings
                },
                after: recalcResult.recalculated,
                transaction_count: recalcResult.transactionCount
            },
            ip_address: req.ip, user_agent: req.headers['user-agent']
        }], { session });

        await session.commitTransaction();
        session.endSession();

        await createNotification(userId, 'Earnings Recalculated',
            'Your earnings have been recalculated by admin to ensure accuracy.',
            'info', '/profile');

        res.json(formatResponse(true, 'Earnings recalculated successfully', {
            user: recalcResult.user,
            recalculated: recalcResult.recalculated,
            transaction_count: recalcResult.transactionCount
        }));
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        handleError(res, error, 'Error recalculating earnings');
    }
});

app.get('/api/admin/pending-investments', adminAuth, async (req, res) => {
    try {
        const pendingInvestments = await Investment.find({ status: 'pending' })
            .populate('user', 'full_name email phone balance total_earnings total_withdrawn')
            .populate('plan', 'name min_amount daily_interest duration')
            .sort({ createdAt: -1 }).lean();

        res.json(formatResponse(true, 'Pending investments retrieved successfully', {
            investments: pendingInvestments,
            count: pendingInvestments.length,
            total_amount: pendingInvestments.reduce((s, i) => s + i.amount, 0),
            stats: {
                with_proof: pendingInvestments.filter(i => i.payment_proof_url).length,
                without_proof: pendingInvestments.filter(i => !i.payment_proof_url).length,
                average_amount: pendingInvestments.length > 0
                    ? pendingInvestments.reduce((s, i) => s + i.amount, 0) / pendingInvestments.length
                    : 0
            }
        }));
    } catch (error) {
        handleError(res, error, 'Error fetching pending investments');
    }
});

app.post('/api/admin/investments/:id/approve', adminAuth, [
    body('remarks').optional().trim()
], async (req, res) => {
    try {
        const investmentId = req.params.id;
        const adminId = req.user._id;
        const { remarks } = req.body;

        const investment = await Investment.findById(investmentId).populate('plan').populate('user');
        if (!investment) return res.status(404).json(formatResponse(false, 'Investment not found'));
        if (investment.status !== 'pending') return res.status(400).json(formatResponse(false, 'Investment is not pending approval'));

        const user = await User.findById(investment.user._id);
        if (investment.amount > user.balance) {
            return res.status(400).json(formatResponse(false,
                `User does not have enough balance. Required: ${investment.amount}, Available: ${user.balance}`));
        }

        await createTransaction(investment.user._id, 'investment', -investment.amount,
            `Investment in ${investment.plan.name} plan`, 'completed', {
            investment_id: investment._id, plan_name: investment.plan.name,
            plan_duration: investment.plan.duration, daily_interest: investment.plan.daily_interest
        });

        const nextInterestDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

        investment.status = 'active';
        investment.approved_at = new Date();
        investment.approved_by = adminId;
        investment.payment_verified = true;
        investment.remarks = remarks;
        investment.next_interest_date = nextInterestDate;
        investment.total_interest_days = investment.plan.duration;
        investment.balance_deducted = true;
        await investment.save();

        await InvestmentPlan.findByIdAndUpdate(investment.plan._id, {
            $inc: { investment_count: 1, total_invested: investment.amount }
        });

        const addInterestResult = await addFirstDayInterest(investment);

        await createNotification(investment.user._id, 'Investment Approved',
            `Your investment of ₦${investment.amount.toLocaleString()} in ${investment.plan.name} has been approved and is now active. First interest of ₦${addInterestResult.dailyEarning?.toLocaleString() || '0'} has been credited.`,
            'investment', '/investments');

        await AdminAudit.create({
            admin_id: adminId, actor: 'admin',
            action: 'approve_investment', target_type: 'investment', target_id: investmentId,
            details: {
                investment_amount: investment.amount,
                plan_name: investment.plan.name,
                user_email: investment.user.email,
                daily_interest_added: addInterestResult.dailyEarning,
                next_interest_date: investment.next_interest_date
            },
            ip_address: req.ip, user_agent: req.headers['user-agent']
        });

        emitToAdmins('investment-approved', {
            investment_id: investmentId, user_id: investment.user._id,
            amount: investment.amount, plan_name: investment.plan.name,
            approved_by: adminId
        });

        res.json(formatResponse(true, 'Investment approved successfully', {
            investment: investment.toObject(),
            interest_added: addInterestResult.success,
            daily_interest: addInterestResult.dailyEarning,
            next_interest_date: investment.next_interest_date
        }));
    } catch (error) {
        handleError(res, error, 'Error approving investment');
    }
});

app.post('/api/admin/investments/:id/reject', adminAuth, [
    body('rejection_reason').notEmpty().trim().isLength({ min: 5, max: 500 })
], async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false, 'Validation failed'));
        }

        const investmentId = req.params.id;
        const adminId = req.user._id;
        const { rejection_reason } = req.body;

        const investment = await Investment.findById(investmentId)
            .populate('plan').populate('user').session(session);
        if (!investment) {
            await session.abortTransaction(); session.endSession();
            return res.status(404).json(formatResponse(false, 'Investment not found'));
        }
        if (investment.status !== 'active' && investment.status !== 'pending') {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false, 'Investment cannot be rejected in its current state'));
        }

        if (investment.status === 'active' && investment.balance_deducted) {
            const user = await User.findById(investment.user._id).session(session);
            user.balance += investment.amount;
            if (investment.earned_so_far > 0) {
                user.total_earnings = Math.max(0, user.total_earnings - investment.earned_so_far);
            }
            await user.save({ session });

            const refundTransaction = new Transaction({
                user: investment.user._id, type: 'refund', amount: investment.amount,
                description: `Refund for rejected investment in ${investment.plan.name} (${rejection_reason})`,
                status: 'completed', reference: generateReference('REF'),
                balance_before: user.balance - investment.amount,
                balance_after: user.balance,
                related_investment: investment._id,
                metadata: { rejected_by: adminId, rejection_reason }
            });
            await refundTransaction.save({ session });

            investment.reversal_transaction_id = refundTransaction._id;
            investment.reversed_at = new Date();
        }

        investment.status = 'rejected';
        investment.rejected_at = new Date();
        investment.rejected_by = adminId;
        investment.rejection_reason = rejection_reason;
        await investment.save({ session });

        await AdminAudit.create([{
            admin_id: adminId, actor: 'admin',
            action: 'reject_investment', target_type: 'investment', target_id: investmentId,
            details: {
                investment_amount: investment.amount,
                plan_name: investment.plan.name,
                user_email: investment.user.email,
                rejection_reason, reversal_applied: investment.balance_deducted
            },
            ip_address: req.ip, user_agent: req.headers['user-agent']
        }], { session });

        await session.commitTransaction();
        session.endSession();

        await createNotification(investment.user._id, 'Investment Rejected',
            `Your investment of ₦${investment.amount.toLocaleString()} in ${investment.plan.name} has been rejected. Reason: ${rejection_reason}.${investment.balance_deducted ? ' The invested amount has been refunded to your balance.' : ''}`,
            'error', '/investments');

        emitToAdmins('investment-rejected', {
            investment_id: investmentId, user_id: investment.user._id,
            amount: investment.amount, plan_name: investment.plan.name,
            rejected_by: adminId, rejection_reason, refunded: investment.balance_deducted
        });

        res.json(formatResponse(true, 'Investment rejected successfully' + (investment.balance_deducted ? ' and amount refunded' : ''), {
            investment: investment.toObject()
        }));
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        handleError(res, error, 'Error rejecting investment');
    }
});

app.get('/api/admin/pending-deposits', adminAuth, async (req, res) => {
    try {
        const pendingDeposits = await Deposit.find({ status: 'pending' })
            .populate('user', 'full_name email phone balance total_earnings total_withdrawn')
            .sort({ createdAt: -1 }).lean();

        res.json(formatResponse(true, 'Pending deposits retrieved successfully', {
            deposits: pendingDeposits,
            count: pendingDeposits.length,
            total_amount: pendingDeposits.reduce((s, d) => s + d.amount, 0)
        }));
    } catch (error) {
        handleError(res, error, 'Error fetching pending deposits');
    }
});

app.post('/api/admin/deposits/:id/approve', adminAuth, [
    body('remarks').optional().trim()
], async (req, res) => {
    try {
        const depositId = req.params.id;
        const adminId = req.user._id;
        const { remarks } = req.body;

        const deposit = await Deposit.findById(depositId).populate('user');
        if (!deposit) return res.status(404).json(formatResponse(false, 'Deposit not found'));
        if (deposit.status !== 'pending') return res.status(400).json(formatResponse(false, 'Deposit is not pending approval'));

        deposit.status = 'approved';
        deposit.approved_at = new Date();
        deposit.approved_by = adminId;
        deposit.admin_notes = remarks;
        await deposit.save();

        await createTransaction(deposit.user._id, 'deposit', deposit.amount,
            `Deposit via ${deposit.payment_method}`, 'completed', {
            deposit_id: deposit._id, payment_method: deposit.payment_method
        });

        await createNotification(deposit.user._id, 'Deposit Approved',
            `Your deposit of ₦${deposit.amount.toLocaleString()} has been approved and credited to your account.`,
            'success', '/deposits');

        await AdminAudit.create({
            admin_id: adminId, actor: 'admin',
            action: 'approve_deposit', target_type: 'deposit', target_id: depositId,
            details: {
                deposit_amount: deposit.amount,
                payment_method: deposit.payment_method,
                user_email: deposit.user.email
            },
            ip_address: req.ip, user_agent: req.headers['user-agent']
        });

        emitToAdmins('deposit-approved', {
            deposit_id: depositId, user_id: deposit.user._id,
            amount: deposit.amount, payment_method: deposit.payment_method,
            approved_by: adminId
        });

        res.json(formatResponse(true, 'Deposit approved successfully', { deposit: deposit.toObject() }));
    } catch (error) {
        handleError(res, error, 'Error approving deposit');
    }
});

app.post('/api/admin/deposits/:id/reject', adminAuth, [
    body('rejection_reason').notEmpty().trim().isLength({ min: 5, max: 500 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json(formatResponse(false, 'Validation failed'));

        const depositId = req.params.id;
        const adminId = req.user._id;
        const { rejection_reason } = req.body;

        const deposit = await Deposit.findById(depositId).populate('user');
        if (!deposit) return res.status(404).json(formatResponse(false, 'Deposit not found'));
        if (deposit.status !== 'pending') return res.status(400).json(formatResponse(false, 'Deposit is not pending'));

        deposit.status = 'rejected';
        deposit.rejected_at = new Date();
        deposit.rejected_by = adminId;
        deposit.rejection_reason = rejection_reason;
        await deposit.save();

        await AdminAudit.create({
            admin_id: adminId, actor: 'admin',
            action: 'reject_deposit', target_type: 'deposit', target_id: depositId,
            details: {
                deposit_amount: deposit.amount,
                payment_method: deposit.payment_method,
                user_email: deposit.user.email,
                rejection_reason
            },
            ip_address: req.ip, user_agent: req.headers['user-agent']
        });

        await createNotification(deposit.user._id, 'Deposit Rejected',
            `Your deposit request of ₦${deposit.amount.toLocaleString()} has been rejected. Reason: ${rejection_reason}. Please contact support for more information.`,
            'error', '/deposits');

        emitToAdmins('deposit-rejected', {
            deposit_id: depositId, user_id: deposit.user._id,
            amount: deposit.amount, payment_method: deposit.payment_method,
            rejected_by: adminId, rejection_reason
        });

        res.json(formatResponse(true, 'Deposit rejected successfully', { deposit: deposit.toObject() }));
    } catch (error) {
        handleError(res, error, 'Error rejecting deposit');
    }
});

app.get('/api/admin/pending-withdrawals', adminAuth, async (req, res) => {
    try {
        const pendingWithdrawals = await Withdrawal.find({
            status: 'pending',
            admin_review_status: 'pending_review'
        })
            .populate('user', 'full_name email phone balance total_earnings total_withdrawn reserved_earnings')
            .sort({ createdAt: -1 }).lean();

        res.json(formatResponse(true, 'Pending withdrawals retrieved successfully', {
            withdrawals: pendingWithdrawals,
            count: pendingWithdrawals.length,
            total_amount: pendingWithdrawals.reduce((s, w) => s + w.amount, 0)
        }));
    } catch (error) {
        handleError(res, error, 'Error fetching pending withdrawals');
    }
});

app.post('/api/admin/withdrawals/:id/approve', adminAuth, [
    body('transaction_id').optional().trim(),
    body('remarks').optional().trim()
], async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const withdrawalId = req.params.id;
        const adminId = req.user._id;
        const { transaction_id, remarks } = req.body;

        const withdrawal = await Withdrawal.findById(withdrawalId).populate('user').session(session);
        if (!withdrawal) {
            await session.abortTransaction(); session.endSession();
            return res.status(404).json(formatResponse(false, 'Withdrawal not found'));
        }
        if (withdrawal.status !== 'pending') {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false, 'Withdrawal is not pending approval'));
        }

        const user = await User.findById(withdrawal.user._id).session(session);
        if (withdrawal.amount > (user.withdrawable_earnings || 0)) {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false,
                `User does not have enough earnings. Available: ${user.withdrawable_earnings}`));
        }

        withdrawal.status = 'paid';
        withdrawal.approved_at = new Date();
        withdrawal.approved_by = adminId;
        withdrawal.paid_at = new Date();
        withdrawal.transaction_id = transaction_id;
        withdrawal.admin_notes = remarks;
        withdrawal.admin_review_status = 'approved';
        withdrawal.reviewed_by = adminId;
        withdrawal.review_date = new Date();
        await withdrawal.save({ session });

        const pendingTransaction = await Transaction.findById(withdrawal.transaction_id_ref).session(session);
        if (pendingTransaction) {
            pendingTransaction.status = 'completed';
            pendingTransaction.description = `Withdrawal via ${withdrawal.payment_method}`;
            await pendingTransaction.save({ session });
        }

        user.reserved_earnings = Math.max(0, (user.reserved_earnings || 0) - withdrawal.amount);
        user.total_withdrawn += withdrawal.amount;
        user.total_withdrawals = (user.total_withdrawals || 0) + withdrawal.amount;
        user.last_withdrawal_date = new Date();
        await user.save({ session });

        await session.commitTransaction();
        session.endSession();

        await createNotification(withdrawal.user._id, 'Withdrawal Approved',
            `Your withdrawal of ₦${withdrawal.amount.toLocaleString()} has been approved and processed.`,
            'success', '/withdrawals');

        await AdminAudit.create({
            admin_id: adminId, actor: 'admin',
            action: 'approve_withdrawal', target_type: 'withdrawal', target_id: withdrawalId,
            details: {
                withdrawal_amount: withdrawal.amount,
                payment_method: withdrawal.payment_method,
                user_email: withdrawal.user.email,
                transaction_id
            },
            ip_address: req.ip, user_agent: req.headers['user-agent']
        });

        emitToAdmins('withdrawal-approved', {
            withdrawal_id: withdrawalId, user_id: withdrawal.user._id,
            amount: withdrawal.amount, payment_method: withdrawal.payment_method,
            approved_by: adminId
        });

        res.json(formatResponse(true, 'Withdrawal approved successfully', { withdrawal: withdrawal.toObject() }));
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        handleError(res, error, 'Error approving withdrawal');
    }
});

app.post('/api/admin/withdrawals/:id/reject', adminAuth, [
    body('rejection_reason').notEmpty().trim()
], async (req, res) => {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
        const withdrawalId = req.params.id;
        const adminId = req.user._id;
        const { rejection_reason } = req.body;

        const withdrawal = await Withdrawal.findById(withdrawalId).populate('user').session(session);
        if (!withdrawal) {
            await session.abortTransaction(); session.endSession();
            return res.status(404).json(formatResponse(false, 'Withdrawal not found'));
        }
        if (withdrawal.status !== 'pending') {
            await session.abortTransaction(); session.endSession();
            return res.status(400).json(formatResponse(false, 'Withdrawal is not pending'));
        }

        withdrawal.status = 'rejected';
        withdrawal.admin_review_status = 'rejected';
        withdrawal.reviewed_by = adminId;
        withdrawal.review_date = new Date();
        withdrawal.review_notes = rejection_reason;
        await withdrawal.save({ session });

        const pendingTransaction = await Transaction.findById(withdrawal.transaction_id_ref).session(session);
        if (pendingTransaction) {
            pendingTransaction.status = 'cancelled';
            pendingTransaction.description = `Withdrawal rejected: ${rejection_reason}`;
            await pendingTransaction.save({ session });
        }

        const user = await User.findById(withdrawal.user._id).session(session);
        user.reserved_earnings = Math.max(0, (user.reserved_earnings || 0) - withdrawal.amount);
        await user.save({ session });

        await session.commitTransaction();
        session.endSession();

        await createNotification(withdrawal.user._id, 'Withdrawal Rejected',
            `Your withdrawal request of ₦${withdrawal.amount.toLocaleString()} has been rejected. Reason: ${rejection_reason}`,
            'error', '/withdrawals');

        await AdminAudit.create({
            admin_id: adminId, actor: 'admin',
            action: 'reject_withdrawal', target_type: 'withdrawal', target_id: withdrawalId,
            details: {
                withdrawal_amount: withdrawal.amount,
                payment_method: withdrawal.payment_method,
                user_email: withdrawal.user.email,
                rejection_reason
            },
            ip_address: req.ip, user_agent: req.headers['user-agent']
        });

        emitToAdmins('withdrawal-rejected', {
            withdrawal_id: withdrawalId, user_id: withdrawal.user._id,
            amount: withdrawal.amount, payment_method: withdrawal.payment_method,
            rejected_by: adminId, rejection_reason
        });

        res.json(formatResponse(true, 'Withdrawal rejected successfully', { withdrawal: withdrawal.toObject() }));
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        handleError(res, error, 'Error rejecting withdrawal');
    }
});

app.get('/api/admin/pending-kyc', adminAuth, async (req, res) => {
    try {
        const pendingKYC = await KYCSubmission.find({ status: 'pending' })
            .populate('user', 'full_name email phone balance total_earnings total_withdrawn')
            .sort({ createdAt: -1 }).lean();

        res.json(formatResponse(true, 'Pending KYC submissions retrieved successfully', {
            kyc_submissions: pendingKYC, count: pendingKYC.length
        }));
    } catch (error) {
        handleError(res, error, 'Error fetching pending KYC');
    }
});

app.post('/api/admin/kyc/:id/approve', adminAuth, [
    body('remarks').optional().trim()
], async (req, res) => {
    try {
        const kycId = req.params.id;
        const adminId = req.user._id;
        const { remarks } = req.body;

        const kyc = await KYCSubmission.findById(kycId).populate('user');
        if (!kyc) return res.status(404).json(formatResponse(false, 'KYC submission not found'));
        if (kyc.status !== 'pending') return res.status(400).json(formatResponse(false, 'KYC is not pending'));

        kyc.status = 'approved';
        kyc.reviewed_by = adminId;
        kyc.reviewed_at = new Date();
        kyc.notes = remarks;
        await kyc.save();

        await User.findByIdAndUpdate(kyc.user._id, {
            kyc_status: 'verified', kyc_verified: true, kyc_verified_at: new Date(),
            'bank_details.verified': true, 'bank_details.verified_at': new Date()
        });

        await createNotification(kyc.user._id, 'KYC Approved',
            'Your KYC documents have been verified and approved. You can now enjoy full platform access.',
            'kyc', '/profile');

        await AdminAudit.create({
            admin_id: adminId, actor: 'admin',
            action: 'approve_kyc', target_type: 'kyc', target_id: kycId,
            details: { user_email: kyc.user.email, id_type: kyc.id_type },
            ip_address: req.ip, user_agent: req.headers['user-agent']
        });

        emitToAdmins('kyc-approved', { kyc_id: kycId, user_id: kyc.user._id, approved_by: adminId });

        res.json(formatResponse(true, 'KYC approved successfully', { kyc: kyc.toObject() }));
    } catch (error) {
        handleError(res, error, 'Error approving KYC');
    }
});

app.get('/api/admin/aml-flags', adminAuth, async (req, res) => {
    try {
        const amlFlags = await AmlMonitoring.find({ status: 'pending_review' })
            .populate('user', 'full_name email balance total_earnings total_withdrawn')
            .sort({ risk_score: -1, createdAt: -1 }).lean();

        res.json(formatResponse(true, 'AML flags retrieved successfully', {
            flags: amlFlags, count: amlFlags.length
        }));
    } catch (error) {
        handleError(res, error, 'Error fetching AML flags');
    }
});

app.get('/api/admin/financial-report', adminAuth, async (req, res) => {
    try {
        const { start_date, end_date } = req.query;

        const matchStage = {};
        if (start_date || end_date) {
            matchStage.createdAt = {};
            if (start_date) matchStage.createdAt.$gte = new Date(start_date);
            if (end_date) matchStage.createdAt.$lte = new Date(end_date);
        }

        const userFinancials = await User.aggregate([
            { $match: { role: { $ne: 'super_admin' } } },
            {
                $group: {
                    _id: null,
                    total_balance: { $sum: '$balance' },
                    total_earnings: { $sum: '$total_earnings' },
                    total_referral_earnings: { $sum: '$referral_earnings' },
                    total_reserved: { $sum: '$reserved_earnings' },
                    total_withdrawn: { $sum: '$total_withdrawn' },
                    total_deposits: { $sum: '$total_deposits' },
                    total_withdrawals: { $sum: '$total_withdrawals' },
                    total_investments: { $sum: '$total_investments' },
                    user_count: { $sum: 1 },
                    active_users: { $sum: { $cond: [{ $eq: ['$is_active', true] }, 1, 0] } },
                    verified_users: { $sum: { $cond: [{ $eq: ['$kyc_verified', true] }, 1, 0] } }
                }
            }
        ]);

        const transactionStats = await Transaction.aggregate([
            { $match: matchStage },
            { $group: { _id: '$type', count: { $sum: 1 }, total_amount: { $sum: '$amount' } } }
        ]);

        const depositStats = await Deposit.aggregate([
            { $match: { ...matchStage, status: 'approved' } },
            { $group: { _id: null, count: { $sum: 1 }, total_amount: { $sum: '$amount' }, avg_amount: { $avg: '$amount' } } }
        ]);

        const withdrawalStats = await Withdrawal.aggregate([
            { $match: { ...matchStage, status: 'paid' } },
            { $group: { _id: null, count: { $sum: 1 }, total_amount: { $sum: '$amount' }, total_fees: { $sum: '$platform_fee' }, avg_amount: { $avg: '$amount' } } }
        ]);

        const investmentStats = await Investment.aggregate([
            { $match: matchStage },
            { $group: { _id: '$status', count: { $sum: 1 }, total_amount: { $sum: '$amount' }, total_earned: { $sum: '$earned_so_far' } } }
        ]);

        res.json(formatResponse(true, 'Financial report generated successfully', {
            user_financials: userFinancials[0] || {},
            transaction_summary: transactionStats,
            deposit_summary: depositStats[0] || {},
            withdrawal_summary: withdrawalStats[0] || {},
            investment_summary: investmentStats,
            date_range: { start_date: start_date || 'Beginning', end_date: end_date || 'Now' }
        }));
    } catch (error) {
        console.error('Financial report error:', error);
        handleError(res, error, 'Error generating financial report');
    }
});

// ==================== ADMIN AWARDS ====================
app.get('/api/admin/awards/claims', adminAuth, async (req, res) => {
    try {
        const { status, page = 1, limit = 50 } = req.query;
        const query = {};
        if (status) query.status = status;

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const [claims, total] = await Promise.all([
            AwardClaim.find(query)
                .populate('user', 'full_name email phone kyc_verified confirmed_referral_count')
                .populate('tier', 'tier_number title reward_name reward_icon image_url accent_color estimated_value_ngn')
                .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).lean(),
            AwardClaim.countDocuments(query)
        ]);

        const byStatus = await AwardClaim.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);

        res.json(formatResponse(true, 'Admin claims retrieved', {
            claims,
            pagination: {
                page: parseInt(page), limit: parseInt(limit), total,
                pages: Math.ceil(total / limit)
            },
            stats: byStatus.reduce((a, s) => { a[s._id] = s.count; return a; }, {})
        }));
    } catch (err) {
        handleError(res, err, 'Error fetching admin claims');
    }
});

app.post('/api/admin/awards/claims/:id/status', adminAuth, async (req, res) => {
    try {
        const { status, reason, tracking_info, admin_notes } = req.body || {};
        const allowed = ['under_review', 'approved', 'fulfilled', 'rejected'];
        if (!allowed.includes(status)) {
            return res.status(400).json(formatResponse(false, 'Invalid status. Allowed: ' + allowed.join(', ')));
        }

        const claim = await AwardClaim.findById(req.params.id).populate('user').populate('tier');
        if (!claim) return res.status(404).json(formatResponse(false, 'Claim not found'));

        claim.status = status;
        claim.reviewed_by = req.user._id;
        claim.reviewed_at = new Date();
        if (admin_notes) claim.admin_notes = admin_notes;
        if (status === 'rejected') claim.rejection_reason = reason || 'Does not meet programme terms.';
        if (status === 'fulfilled') {
            claim.fulfilled_at = new Date();
            if (tracking_info) claim.tracking_info = tracking_info;
        }
        await claim.save();

        const titles = {
            under_review: 'Claim Under Review',
            approved: 'Claim Approved',
            fulfilled: 'Reward Dispatched',
            rejected: 'Claim Rejected'
        };
        const bodies = {
            under_review: `We are currently reviewing your claim for ${claim.tier.reward_name}.`,
            approved: `Your claim has been approved. We are preparing ${claim.tier.reward_name} for dispatch.`,
            fulfilled: `Your reward has been dispatched.${claim.tracking_info ? ' Tracking: ' + claim.tracking_info : ''}`,
            rejected: `Your claim was rejected: ${claim.rejection_reason}`
        };

        await createNotification(
            claim.user._id,
            titles[status],
            bodies[status],
            status === 'rejected' ? 'error' : 'success',
            '/awards',
            { award_tier_number: claim.tier_number, claim_id: String(claim._id), status }
        );

        await AdminAudit.create({
            admin_id: req.user._id, actor: 'admin',
            action: 'update_award_claim_status',
            target_type: 'award_claim', target_id: claim._id,
            details: { new_status: status, reason, tracking_info, admin_notes, user_id: claim.user._id },
            ip_address: req.ip, user_agent: req.headers['user-agent']
        });

        emitToAwardAdmins('award-claim-updated', {
            claim_id: claim._id, status, reviewed_by: req.user._id
        });
        emitToUser(claim.user._id, 'award-claim-status', {
            claim_id: claim._id, tier_number: claim.tier_number, status
        });

        res.json(formatResponse(true, 'Claim status updated', { claim }));
    } catch (err) {
        handleError(res, err, 'Error updating claim status');
    }
});

app.post('/api/admin/awards/seed', adminAuth, async (req, res) => {
    try {
        const result = await seedAwardTiers();
        res.json(formatResponse(true, 'Tier seed completed', result));
    } catch (err) {
        handleError(res, err, 'Error seeding tiers');
    }
});

// ==================== 404 & GLOBAL ERROR ====================
app.use((req, res) => {
    res.status(404).json(formatResponse(false, 'Endpoint not found'));
});

app.use((err, req, res, next) => {
    console.error(`🚨 [${req.id}] Unhandled error:`, err);

    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json(formatResponse(false, 'File too large. Maximum size is 10MB'));
        }
        return res.status(400).json(formatResponse(false, `File upload error: ${err.message}`));
    }

    if (err.name === 'ValidationError') {
        const messages = Object.values(err.errors).map(e => e.message);
        return res.status(400).json(formatResponse(false, 'Validation Error', { errors: messages }));
    }

    if (err.name === 'JsonWebTokenError') {
        return res.status(401).json(formatResponse(false, 'Invalid token'));
    }

    if (err.name === 'TokenExpiredError') {
        return res.status(401).json(formatResponse(false, 'Token expired'));
    }

    if (err.message === 'Not allowed by CORS') {
        return res.status(403).json(formatResponse(false, 'Origin not allowed by CORS'));
    }

    if (err.type === 'entity.parse.failed') {
        return res.status(400).json(formatResponse(false, 'Invalid JSON in request body'));
    }

    const statusCode = err.statusCode || 500;
    const message = config.nodeEnv === 'production' && statusCode === 500 ? 'Internal server error' : err.message;
    res.status(statusCode).json(formatResponse(false, message));
});

// ==================== STARTUP / SHUTDOWN ====================
let isShuttingDown = false;
let isDbReady = false;

const startServer = async () => {
    try {
        await initializeDatabase();
        isDbReady = true;

        server.listen(config.port, () => {
            console.log('\n🚀 ============================================');
            console.log('✅ Liquidated Backend v59.0 - Production / Awards Ready');
            console.log(`🌐 Environment: ${config.nodeEnv}`);
            console.log(`📍 Port: ${config.port}`);
            console.log(`🔗 Server URL: ${config.serverURL}`);
            console.log(`🔗 Client URL: ${config.clientURL}`);
            console.log(`🏆 Awards Frontend: ${config.awardsFrontendURL}`);
            console.log('☁️  Cloudinary: Connected');
            console.log('🔌 Socket.IO: Enabled with JWT Authentication');
            console.log('📊 Database: Connected');
            console.log('============================================\n');
            console.log('🎯 v59.0 HIGHLIGHTS:');
            console.log('1. ✅ 16-tier Referral Awards ladder (5 → 2000+ referrals)');
            console.log('2. ✅ Award tier seed, eligibility engine, leaderboard');
            console.log('3. ✅ /api/awards/* + /api/admin/awards/* endpoints');
            console.log('4. ✅ Socket.IO real-time award notifications');
            console.log('5. ✅ GDPR account data export endpoint');
            console.log('6. ✅ Cloudinary storage (ephemeral-disk-proof uploads)');
            console.log('7. ✅ KYC documents stored as authenticated + signed URLs');
            console.log('8. ✅ Body parser fix – PUT JSON parsing regardless of Content-Type');
            console.log('9. ✅ Distributed cron locks (multi-instance safe)');
            console.log('10. ✅ Reserved earnings on withdrawal, atomic balance ops');
            console.log('11. ✅ Full admin audit trail on all sensitive actions');
            console.log('12. ✅ Graceful shutdown with 10s drain budget');
            console.log('============================================\n');
        });
    } catch (error) {
        console.error('❌ Failed to start server:', error);
        process.exit(1);
    }
};

const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    console.log(`👋 ${signal} received. Shutting down gracefully...`);

    const drain = setTimeout(() => {
        console.error('⏰ Forced shutdown after 10s drain budget');
        process.exit(1);
    }, 10000);

    try {
        // Stop accepting new connections
        server.close(() => console.log('✅ HTTP server closed'));

        // Close Socket.IO connections
        try { io.close(); } catch (_) { /* noop */ }

        // Close Mongo connection
        if (isDbReady) {
            await mongoose.connection.close();
            console.log('✅ MongoDB connection closed');
        }

        clearTimeout(drain);
        process.exit(0);
    } catch (err) {
        console.error('Shutdown error:', err);
        clearTimeout(drain);
        process.exit(1);
    }
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
    console.error('🚨 Unhandled Promise Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('🚨 Uncaught Exception:', err);
    // Give logger a chance to flush, then exit
    setTimeout(() => process.exit(1), 1000);
});

startServer();
