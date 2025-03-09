const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const port = 3000; // Use port 3000 for the backend server

const db = new sqlite3.Database('./database.sqlite');

app.use(cors());
app.use(bodyParser.json());

// Endpoint to get messages
app.get('/messages', (req, res) => {
  db.all('SELECT * FROM messages ORDER BY created_at ASC', [], (err, rows) => {
    if (err) {
      res.status(500).send(err.message);
      return;
    }
    res.json(rows);
  });
});

// Endpoint to add a message
app.post('/messages', (req, res) => {
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
app.delete('/messages/:id', (req, res) => {
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
  console.log(`Server is running on http://localhost:${port}`);
});