require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const db = require('./db');

const GRUPO_ID = process.env.GRUPO_ID || '';

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }) // Pode deixar silent novamente para manter o terminal limpo
    });

    sock.ev.on('creds.update', saveCreds);

    // --- NOVA LÓGICA DE CONEXÃO E QR CODE ---
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('Escaneie o QR Code abaixo com seu WhatsApp:');
            qrcode.generate(qr, { small: true });
        }
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada. Reconectando...', shouldReconnect);
            if(shouldReconnect) {
                startBot();
            }
        } else if (connection === 'open') {
            console.log('✅ Conectado ao WhatsApp com sucesso!');
        }
    });

    // A partir daqui, o código de mensagens continua igual ao anterior
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message) return;

        const jid = msg.key.remoteJid;
        const texto = msg.message.conversation || msg.message.extendedTextMessage?.text;
        
        if (!texto) return;

        // Linha provisória para descobrir o ID do grupo
        console.log(`Mensagem recebida de: ${jid} | Texto: ${texto}`);

        if (jid !== GRUPO_ID) return;

        const autor = msg.key.participant || msg.key.remoteJid;

        // --- COMANDO: /limite [valor] ---
        const limiteMatch = texto.match(/^\/limite\s+([\d.,]+)$/i);
        if (limiteMatch) {
            const novoLimite = parseFloat(limiteMatch[1].replace(',', '.'));
            db.prepare('UPDATE configuracoes SET limite_mensal = ? WHERE id = 1').run(novoLimite);
            await sock.sendMessage(jid, { text: `✅ Limite mensal atualizado para R$ ${novoLimite.toFixed(2)}` });
            return;
        }

        // --- COMANDO: gasto [valor] [categoria] ---
        const gastoMatch = texto.match(/^gasto\s+([\d.,]+)\s+(.+)$/i);
        if (gastoMatch) {
            const valor = parseFloat(gastoMatch[1].replace(',', '.'));
            const categoria = gastoMatch[2].trim();
            const dataAtual = new Date().toISOString(); // Formato: YYYY-MM-DDTHH:mm:ss.sssZ

            // Salva no banco
            db.prepare('INSERT INTO gastos (data, valor, categoria, autor) VALUES (?, ?, ?, ?)').run(dataAtual, valor, categoria, autor);

            // Calcula total do mês atual
            const mesAtual = dataAtual.substring(0, 7); // Pega 'YYYY-MM'
            const gastosDoMes = db.prepare(`
                SELECT SUM(valor) as total FROM gastos 
                WHERE data LIKE ?
            `).get(`${mesAtual}%`).total || 0;

            const config = db.prepare('SELECT limite_mensal FROM configuracoes WHERE id = 1').get();
            let resposta = `💸 Gasto de R$ ${valor.toFixed(2)} em *${categoria}* registrado com sucesso!\n`;
            
            if (config.limite_mensal > 0) {
                const percentual = ((gastosDoMes / config.limite_mensal) * 100).toFixed(1);
                resposta += `\n📊 Total do mês: R$ ${gastosDoMes.toFixed(2)} de R$ ${config.limite_mensal.toFixed(2)} (${percentual}%)`;
                
                if (gastosDoMes > config.limite_mensal) {
                    resposta += `\n⚠️ *ATENÇÃO: Vocês ultrapassaram o limite!*`;
                }
            }

            await sock.sendMessage(jid, { text: resposta });
            return;
        }

        // --- COMANDO: /relatorio ---
        if (texto.trim().toLowerCase() === '/relatorio') {
            const dataAtual = new Date().toISOString();
            const mesAtual = dataAtual.substring(0, 7);
            
            const total = db.prepare(`SELECT SUM(valor) as total FROM gastos WHERE data LIKE ?`).get(`${mesAtual}%`).total || 0;
            const gastosPorCategoria = db.prepare(`
                SELECT categoria, SUM(valor) as total_cat 
                FROM gastos 
                WHERE data LIKE ? 
                GROUP BY categoria 
                ORDER BY total_cat DESC
            `).all(`${mesAtual}%`);

            let msgRelatorio = `*Resumo do Mês (${mesAtual})*\nTotal Gasto: R$ ${total.toFixed(2)}\n\n*Por categoria:*\n`;
            gastosPorCategoria.forEach(g => {
                msgRelatorio += `- ${g.categoria}: R$ ${g.total_cat.toFixed(2)}\n`;
            });

            await sock.sendMessage(jid, { text: msgRelatorio });
            return;
        }
    });
}

startBot();