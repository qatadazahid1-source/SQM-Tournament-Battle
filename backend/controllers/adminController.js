// File: backend/controllers/adminController.js

const db = require('../config/db');

// @desc    Get Admin Dashboard Stats
// @route   GET /api/admin/stats
// @access  Admin
exports.getDashboardStats = async (req, res) => {
    try {
        const usersCount = await db.query('SELECT COUNT(*) FROM users');
        const tournamentsCount = await db.query('SELECT COUNT(*) FROM tournaments');
        const deposits = await db.query("SELECT SUM(amount) FROM transactions WHERE type='deposit' AND status='completed'");
        const withdrawals = await db.query("SELECT SUM(amount) FROM transactions WHERE type='withdrawal' AND status='completed'");
        const pendingDeposits = await db.query("SELECT COUNT(*) FROM transactions WHERE type='deposit' AND status='pending'");

        res.status(200).json({
            success: true,
            data: {
                total_users: parseInt(usersCount.rows[0].count),
                total_tournaments: parseInt(tournamentsCount.rows[0].count),
                total_deposited: parseFloat(deposits.rows[0].sum || 0),
                total_withdrawn: parseFloat(withdrawals.rows[0].sum || 0),
                pending_deposits: parseInt(pendingDeposits.rows[0].count)
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

// ==========================================
// TOURNAMENT MANAGEMENT
// ==========================================

// @desc    Create Tournament
// @route   POST /api/admin/tournaments
// @access  Admin
exports.createTournament = async (req, res) => {
    const { title, game_type, map_type, entry_fee, prize_pool, per_kill, start_time, max_players } = req.body;
    
    try {
        const result = await db.query(
            `INSERT INTO tournaments 
            (title, game_type, map_type, entry_fee, prize_pool, per_kill, start_time, max_players, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [title, game_type, map_type, entry_fee, prize_pool, per_kill, start_time, max_players, req.user.id]
        );
        res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

// @desc    Update Room ID & Password
// @route   PUT /api/admin/tournaments/:id/room
// @access  Admin
exports.updateRoomDetails = async (req, res) => {
    const { room_id, room_password } = req.body;
    try {
        await db.query(
            'UPDATE tournaments SET room_id = $1, room_password = $2 WHERE id = $3',
            [room_id, room_password, req.params.id]
        );
        
        // Notify users (Simplified: In real app, trigger push notification here)
        
        res.status(200).json({ success: true, message: 'Room details updated' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

// @desc    Cancel Tournament & Refund
// @route   POST /api/admin/tournaments/:id/cancel
// @access  Admin
exports.cancelTournament = async (req, res) => {
    const tournamentId = req.params.id;
    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        const tourRes = await client.query('SELECT * FROM tournaments WHERE id = $1', [tournamentId]);
        if (tourRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Tournament not found' });
        }
        const tournament = tourRes.rows[0];

        if (tournament.status === 'cancelled') {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Already cancelled' });
        }

        // Logic: Refund all participants
        const participants = await client.query(
            'SELECT user_id FROM tournament_participants WHERE tournament_id = $1',
            [tournamentId]
        );

        for (let p of participants.rows) {
            // Refund Wallet
            await client.query(
                'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
                [tournament.entry_fee, p.user_id]
            );
            
            // Log Transaction
            await client.query(
                `INSERT INTO transactions (user_id, type, amount, status, admin_note)
                 VALUES ($1, 'refund', $2, 'completed', $3)`,
                [p.user_id, tournament.entry_fee, `Refund for Tournament ID: ${tournamentId}`]
            );
        }

        // Update Tournament Status
        await client.query(
            "UPDATE tournaments SET status = 'cancelled' WHERE id = $1",
            [tournamentId]
        );

        await client.query('COMMIT');
        res.status(200).json({ success: true, message: 'Tournament cancelled and refunded' });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error' });
    } finally {
        client.release();
    }
};

// ==========================================
// PAYMENT MANAGEMENT
// ==========================================

// @desc    Get Pending Requests (Deposit/Withdrawal)
// @route   GET /api/admin/payments
// @access  Admin
exports.getPendingPayments = async (req, res) => {
    try {
        const result = await db.query(
            "SELECT t.*, u.username, u.email, u.phone FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.status = 'pending' ORDER BY t.created_at ASC"
        );
        res.status(200).json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

// @desc    Approve/Reject Transaction
// @route   PUT /api/admin/payments/:id
// @access  Admin
exports.processPayment = async (req, res) => {
    const { status, admin_note } = req.body; // status: 'approved' or 'rejected'
    const transactionId = req.params.id;
    
    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        const txRes = await client.query('SELECT * FROM transactions WHERE id = $1', [transactionId]);
        if (txRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Transaction not found' });
        }
        const tx = txRes.rows[0];

        if (tx.status !== 'pending') {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Transaction already processed' });
        }

        if (status === 'approved') {
            if (tx.type === 'deposit') {
                // Credit Wallet
                await client.query(
                    'UPDATE wallets SET balance = balance + $1, total_deposited = total_deposited + $1 WHERE user_id = $2',
                    [tx.amount, tx.user_id]
                );
                
                // Referral Bonus Logic (First Deposit)
                const walletRes = await client.query('SELECT total_deposited FROM wallets WHERE user_id = $1', [tx.user_id]);
                // If this was the first deposit (now total > 0, but previously 0? We just added it. Let's check logic)
                // Actually, total_deposited is now updated. If it equals amount, it's first deposit.
                
                if (parseFloat(walletRes.rows[0].total_deposited) === parseFloat(tx.amount)) {
                    // Get Referrer
                    const userRes = await client.query('SELECT referred_by FROM users WHERE id = $1', [tx.user_id]);
                    const referrerId = userRes.rows[0].referred_by;

                    if (referrerId) {
                         const settingRes = await client.query("SELECT value FROM settings WHERE key = 'referral_bonus_percent'");
                         const percent = parseFloat(settingRes.rows[0]?.value || 5);
                         const bonus = (parseFloat(tx.amount) * percent) / 100;

                         if (bonus > 0) {
                             await client.query(
                                 'UPDATE wallets SET bonus_balance = bonus_balance + $1, balance = balance + $1 WHERE user_id = $2',
                                 [bonus, referrerId]
                             );
                             await client.query(
                                 `INSERT INTO transactions (user_id, type, amount, status, admin_note)
                                  VALUES ($1, 'referral_bonus', $2, 'completed', 'Bonus for referring user ${tx.user_id}')`,
                                 [referrerId, bonus]
                             );
                         }
                    }
                }

            } else if (tx.type === 'withdrawal') {
                 // Money already deducted on request. Just update stats.
                 await client.query(
                    'UPDATE wallets SET total_withdrawn = total_withdrawn + $1 WHERE user_id = $2',
                    [tx.amount, tx.user_id]
                );
            }
        } else if (status === 'rejected') {
            if (tx.type === 'withdrawal') {
                // Refund the money back to wallet
                await client.query(
                    'UPDATE wallets SET balance = balance + $1 WHERE user_id = $2',
                    [tx.amount, tx.user_id]
                );
            }
        }

        // Update Transaction Status
        await client.query(
            'UPDATE transactions SET status = $1, admin_note = $2, updated_at = NOW() WHERE id = $3',
            [status, admin_note, transactionId]
        );

        await client.query('COMMIT');
        res.status(200).json({ success: true, message: `Transaction ${status}` });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error' });
    } finally {
        client.release();
    }
};

// ==========================================
// REDEEM CODES & ANNOUNCEMENTS
// ==========================================

// @desc    Create Redeem Code
// @route   POST /api/admin/redeem
// @access  Admin
exports.createRedeemCode = async (req, res) => {
    const { code, amount, max_uses, type, expires_at } = req.body;
    try {
        const result = await db.query(
            `INSERT INTO redeem_codes (code, amount, max_uses, type, expires_at)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [code, amount, max_uses, type, expires_at]
        );
        res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Error creating code' });
    }
};

// @desc    Create Announcement
// @route   POST /api/admin/announcements
// @access  Admin
exports.createAnnouncement = async (req, res) => {
    const { title, message, type } = req.body;
    try {
        const result = await db.query(
            'INSERT INTO announcements (title, message, type) VALUES ($1, $2, $3) RETURNING *',
            [title, message, type]
        );
        res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};
