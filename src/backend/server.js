const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const { execSync } = require('child_process');

const app = express();
const port = 3000; // Use port 3000 for the backend server

const dbFilePath = '/database.sqlite';

// Check if the database file exists
if (!fs.existsSync(dbFilePath)) {
  console.log('Database file not found. Initializing database...');
  execSync('node /app/backend/initSQLite.js');
}

const db = new sqlite3.Database(dbFilePath);

// Check if the messages table exists
db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'", (err, row) => {
  if (err) {
    console.error('Error checking for messages table:', err.message);
  } else if (!row) {
    console.log('Messages table not found. Initializing database...');
    execSync('node /app/backend/initSQLite.js');
  }
});

app.use(cors());
app.use(bodyParser.json());

// Endpoint to get messages
app.get('/api/messages', (req, res) => {
  db.all('SELECT * FROM messages ORDER BY created_at ASC', [], (err, rows) => {
    if (err) {
      res.status(500).send(err.message);
      return;
    }
    res.json(rows);
  });
});

// Endpoint to add a message
app.post('/api/messages', (req, res) => {
  const { text } = req.body;
  db.run('INSERT INTO messages (message) VALUES (?)', [text], function (err) {
    if (err) {
      res.status(500).send(err.message);
      return;
    }
    res.json({ id: this.lastID, message: text, created_at: new Date().toISOString() });
  });
});

// Endpoint to delete a message
app.delete('/api/messages/:id', (req, res) => {
  const { id } = req.params;
  db.run('DELETE FROM messages WHERE id = ?', [id], function (err) {
    if (err) {
      res.status(500).send(err.message);
      return;
    }
    res.status(204).send();
  });
});

app.listen(port, () => {
  console.log(`API Backend is running on http://localhost:${port}`);
});