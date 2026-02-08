// File: backend/controllers/authController.js

const db = require('../config/db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Helper to generate JWT
const generateToken = (id) => {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRE,
    });
};

// Generate random referral code
const generateReferralCode = () => {
    return Math.random().toString(36).substring(2, 10).toUpperCase();
};

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public
exports.register = async (req, res) => {
    const { username, email, password, phone, referral_code } = req.body;
    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Check if user exists
        const userExists = await client.query(
            'SELECT * FROM users WHERE email = $1 OR username = $2',
            [email, username]
        );

        if (userExists.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'User already exists' });
        }

        // 2. Handle Referral
        let referrerId = null;
        if (referral_code) {
            const referrer = await client.query(
                'SELECT id FROM users WHERE referral_code = $1',
                [referral_code]
            );
            if (referrer.rows.length > 0) {
                referrerId = referrer.rows[0].id;
            }
        }

        // 3. Hash password
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const newReferralCode = generateReferralCode();

        // 4. Create User
        const newUser = await client.query(
            `INSERT INTO users (username, email, password_hash, phone, referral_code, referred_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             RETURNING id, username, email, role, referral_code`,
            [username, email, hashedPassword, phone, newReferralCode, referrerId]
        );

        const userId = newUser.rows[0].id;

        // 5. Create Wallet
        await client.query(
            'INSERT INTO wallets (user_id) VALUES ($1)',
            [userId]
        );

        // 6. Check & Apply Signup Bonus
        const settingRes = await client.query("SELECT value FROM settings WHERE key = 'signup_bonus'");
        const signupBonus = parseFloat(settingRes.rows[0]?.value || 0);

        if (signupBonus > 0) {
            // Update wallet
            await client.query(
                'UPDATE wallets SET balance = balance + $1, bonus_balance = bonus_balance + $1 WHERE user_id = $2',
                [signupBonus, userId]
            );

            // Log transaction
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, status, admin_note)
                 VALUES ($1, 'signup_bonus', $2, 'completed', 'Welcome Bonus')`,
                [userId, signupBonus]
            );
        }

        await client.query('COMMIT');

        // 7. Response
        const token = generateToken(userId);
        res.status(201).json({
            success: true,
            token,
            user: newUser.rows[0]
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error' });
    } finally {
        client.release();
    }
};

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
exports.login = async (req, res) => {
    const { email, password } = req.body;

    try {
        // 1. Check for user
        const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        
        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Invalid credentials' });
        }

        const user = result.rows[0];

        // 2. Check Ban Status
        if (user.is_banned) {
            return res.status(403).json({ success: false, message: 'Account is banned' });
        }

        // 3. Match Password
        const isMatch = await bcrypt.compare(password, user.password_hash);

        if (!isMatch) {
            return res.status(400).json({ success: false, message: 'Invalid credentials' });
        }

        // 4. Return Token
        const token = generateToken(user.id);
        res.status(200).json({
            success: true,
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email,
                role: user.role,
                referral_code: user.referral_code
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
exports.getMe = async (req, res) => {
    try {
        const userRes = await db.query(
            'SELECT id, username, email, phone, role, referral_code, created_at FROM users WHERE id = $1',
            [req.user.id]
        );

        const walletRes = await db.query(
            'SELECT balance, bonus_balance, total_deposited, total_withdrawn FROM wallets WHERE user_id = $1',
            [req.user.id]
        );

        const user = userRes.rows[0];
        const wallet = walletRes.rows[0];

        res.status(200).json({
            success: true,
            data: { ...user, wallet }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};
