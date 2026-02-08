// File: backend/controllers/tournamentController.js

const db = require('../config/db');

// @desc    Get all tournaments
// @route   GET /api/tournaments
// @access  Public
exports.getTournaments = async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM tournaments ORDER BY start_time DESC'
        );
        res.status(200).json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

// @desc    Get single tournament
// @route   GET /api/tournaments/:id
// @access  Public
exports.getTournamentById = async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM tournaments WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Tournament not found' });
        }
        res.status(200).json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};

// @desc    Join tournament
// @route   POST /api/tournaments/:id/join
// @access  Private
exports.joinTournament = async (req, res) => {
    const { game_username } = req.body;
    const tournamentId = req.params.id;
    const userId = req.user.id;

    const client = await db.pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Get Tournament Info
        const tourRes = await client.query('SELECT * FROM tournaments WHERE id = $1 FOR UPDATE', [tournamentId]);
        
        if (tourRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Tournament not found' });
        }

        const tournament = tourRes.rows[0];

        // 2. Checks
        if (tournament.current_players >= tournament.max_players) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Tournament is full' });
        }

        if (tournament.status !== 'upcoming') {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Cannot join. Tournament is not upcoming.' });
        }

        // 3. Check if already joined
        const joinedRes = await client.query(
            'SELECT * FROM tournament_participants WHERE tournament_id = $1 AND user_id = $2',
            [tournamentId, userId]
        );

        if (joinedRes.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Already joined' });
        }

        // 4. Check Balance
        const walletRes = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [userId]);
        const balance = parseFloat(walletRes.rows[0].balance);
        const fee = parseFloat(tournament.entry_fee);

        if (balance < fee) {
            await client.query('ROLLBACK');
            return res.status(400).json({ success: false, message: 'Insufficient balance' });
        }

        // 5. Deduct Fee
        await client.query(
            'UPDATE wallets SET balance = balance - $1 WHERE user_id = $2',
            [fee, userId]
        );

        // 6. Add Participant
        await client.query(
            'INSERT INTO tournament_participants (tournament_id, user_id, game_username) VALUES ($1, $2, $3)',
            [tournamentId, userId, game_username]
        );

        // 7. Update Player Count
        await client.query(
            'UPDATE tournaments SET current_players = current_players + 1 WHERE id = $1',
            [tournamentId]
        );

        // 8. Log Transaction
        await client.query(
            `INSERT INTO transactions (user_id, type, amount, status, admin_note)
             VALUES ($1, 'join_fee', $2, 'completed', $3)`,
            [userId, fee, `Joined Tournament ID: ${tournamentId}`]
        );

        await client.query('COMMIT');
        res.status(200).json({ success: true, message: 'Joined successfully' });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ success: false, message: 'Server Error' });
    } finally {
        client.release();
    }
};

// @desc    Get my tournaments
// @route   GET /api/tournaments/my
// @access  Private
exports.getMyTournaments = async (req, res) => {
    try {
        const query = `
            SELECT t.*, tp.game_username
            FROM tournaments t
            JOIN tournament_participants tp ON t.id = tp.tournament_id
            WHERE tp.user_id = $1
            ORDER BY t.start_time DESC
        `;
        const result = await db.query(query, [req.user.id]);
        res.status(200).json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server Error' });
    }
};
