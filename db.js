const Database = require('better-sqlite3');
const db = new Database('financas.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS gastos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT,
    valor REAL,
    categoria TEXT,
    autor TEXT
  );
  
  CREATE TABLE IF NOT EXISTS configuracoes (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    limite_mensal REAL
  );
  
  CREATE TABLE IF NOT EXISTS limites_categorias (
    categoria TEXT PRIMARY KEY,
    limite REAL
  );
  
  INSERT OR IGNORE INTO configuracoes (id, limite_mensal) VALUES (1, 0);
`);

module.exports = db;