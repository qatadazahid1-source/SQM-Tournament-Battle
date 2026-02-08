// File: backend/config/db.js

const { Pool } = require('pg');
const dotenv = require('dotenv');

dotenv.config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

const connectDB = async () => {
    try {
        await pool.query('SELECT NOW()');
        console.log('PostgreSQL Database Connected Successfully');
    } catch (err) {
        console.error('Database Connection Failed:', err.message);
        process.exit(1);
    }
};

module.exports = {
    query: (text, params) => pool.query(text, params),
    pool,
    connectDB,
};
