// File: backend/controllers/walletController.js

const db = require('../config/db');

// @desc    Get user wallet
// @route   GET /api/wallet
// @access  Private
exports.getWallet = async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM wallets WHERE user_id = $1', [req.user.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Wallet not found' });
        }
        res.status(200).json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

// @desc    Request Deposit
// @route   POST /api/wallet/deposit
// @access  Private
exports.requestDeposit = async (req, res) => {
    const { amount, transaction_id_manual, payment_method } = req.body;
    
    // Check if file is uploaded
    if (!req.file) {
        return res.status(400).json({ success: false, message: 'Payment screenshot is required' });
    }

    const proofUrl = req.file.path;

    try {
        await db.query(
            `INSERT INTO transactions 
            (user_id, type, amount, status, payment_method, payment_proof_url, transaction_id_manual)
            VALUES ($1, 'deposit', $2, 'pending', $3, $4, $5)`,
            [req.user.id, amount, payment_method, proofUrl, transaction_id_manual]
        );

        // Notify Admin (Insert into notifications table for admin - simplified logic)
        // In a real app, you might trigger an admin alert via socket or email here.

        res.status(201).json({ success: true, message: 'Deposit request submitted successfully' });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

// @desc    Request Withdrawal
// @route   POST /api/wallet/withdraw
// @access  Private
exports.requestWithdrawal = async (req, res) => {
    const { amount, payment_method, account_details } = req.body;
    // account_details could be '03001234567 - JazzCash'

    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        // Check balance
        const walletRes = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [req.user.id]);
        const currentBalance = parseFloat(walletRes.rows[0].balance);

        if (currentBalance < parseFloat(amount)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Insufficient balance' });
        }

        // Deduct balance temporarily (or hold it)
        // For this logic, we will deduct it immediately. If rejected, we refund.
        await client.query(
            'UPDATE wallets SET balance = balance - $1 WHERE user_id = $2',
            [amount, req.user.id]
        );

        // Create Transaction
        await client.query(
            `INSERT INTO transactions 
            (user_id, type, amount, status, payment_method, admin_note)
            VALUES ($1, 'withdrawal', $2, 'pending', $3, $4)`,
            [req.user.id, amount, payment_method, account_details]
        );

        await client.query('COMMIT');

        res.status(201).json({ success: true, message: 'Withdrawal request submitted' });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error' });
    } finally {
        client.release();
    }
};

// @desc    Get Transaction History
// @route   GET /api/wallet/transactions
// @access  Private
exports.getTransactions = async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM transactions WHERE user_id = $1 ORDER BY created_at DESC',
            [req.user.id]
        );
        res.status(200).json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

// @desc    Redeem Code
// @route   POST /api/wallet/redeem
// @access  Private
exports.redeemCode = async (req, res) => {
    const { code } = req.body;
    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Validate Code
        const codeRes = await client.query(
            'SELECT * FROM redeem_codes WHERE code = $1', 
            [code]
        );

        if (codeRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Invalid code' });
        }

        const promo = codeRes.rows[0];

        // 2. Check if active and not expired
        if (!promo.is_active) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Code is inactive' });
        }

        if (promo.expires_at && new Date() > new Date(promo.expires_at)) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Code expired' });
        }

        if (promo.current_uses >= promo.max_uses) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Code limit reached' });
        }

        // 3. Check if user already used it
        const usedRes = await client.query(
            'SELECT * FROM redeem_history WHERE user_id = $1 AND code_id = $2',
            [req.user.id, promo.id]
        );

        if (usedRes.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'You have already used this code' });
        }

        // 4. Apply Benefit
        await client.query(
            'UPDATE wallets SET balance = balance + $1, bonus_balance = bonus_balance + $1 WHERE user_id = $2',
            [promo.amount, req.user.id]
        );

        // 5. Log History
        await client.query(
            'INSERT INTO redeem_history (user_id, code_id) VALUES ($1, $2)',
            [req.user.id, promo.id]
        );

        // 6. Update Code Usage
        await client.query(
            'UPDATE redeem_codes SET current_uses = current_uses + 1 WHERE id = $1',
            [promo.id]
        );

        // 7. Log Transaction
        await client.query(
            `INSERT INTO transactions (user_id, type, amount, status, admin_note)
             VALUES ($1, 'redeem_code', $2, 'completed', $3)`,
            [req.user.id, promo.amount, `Redeemed code: ${code}`]
        );

        await client.query('COMMIT');
        res.status(200).json({ success: true, message: `Successfully redeemed ${promo.amount}` });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error' });
    } finally {
        client.release();
    }
};
