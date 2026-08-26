require('dotenv').config();
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const db = require('./db');
const fs = require('fs');

const GRUPO_ID = process.env.GRUPO_ID || '';

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            console.log('Escaneie o QR Code abaixo com seu WhatsApp:');
            qrcode.generate(qr, { small: true });
        }
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada. Reconectando...', shouldReconnect);
            if(shouldReconnect) startBot();
        } else if (connection === 'open') {
            console.log('✅ Conectado ao WhatsApp com sucesso!');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message) return;

        const jid = msg.key.remoteJid;
        const texto = msg.message.conversation || msg.message.extendedTextMessage?.text;
        
        if (!texto || jid !== GRUPO_ID) return;

        const textoLower = texto.trim().toLowerCase();
        const autorNumero = msg.key.participant || msg.key.remoteJid;
        const ultimos4Digitos = autorNumero.split('@')[0].slice(-4);
        const identificacaoAutor = `Final ${ultimos4Digitos}`;
        
        const dataAtual = new Date();
        const dataAtualIso = dataAtual.toISOString();
        const mesAtual = dataAtualIso.substring(0, 7);

        // --- EXPORTAR DADOS (CSV) ---
        if (textoLower === '/exportar') {
            const todosGastos = db.prepare('SELECT * FROM gastos ORDER BY data ASC').all();
            if (todosGastos.length === 0) {
                await sock.sendMessage(jid, { text: 'Nenhum dado para exportar.' });
                return;
            }

            let csv = 'ID;Data;Valor;Categoria;Autor\n';
            todosGastos.forEach(g => {
                csv += `${g.id};${g.data};${g.valor.toFixed(2)};${g.categoria};${g.autor}\n`;
            });

            const buffer = Buffer.from(csv, 'utf-8');
            await sock.sendMessage(jid, {
                document: buffer,
                mimetype: 'text/csv',
                fileName: `Exportacao_Gastos_${mesAtual}.csv`,
                caption: '📊 Base de dados exportada com sucesso.'
            });
            return;
        }

        // --- DEFINIR LIMITE POR CATEGORIA ---
        const limCatMatch = texto.match(/^\/limitecat\s+(.+?)\s+([\d.,]+)$/i);
        if (limCatMatch) {
            const categoriaAlvo = limCatMatch[1].trim().toLowerCase();
            const novoLimiteCat = parseFloat(limCatMatch[2].replace(',', '.'));
            
            db.prepare('INSERT OR REPLACE INTO limites_categorias (categoria, limite) VALUES (?, ?)').run(categoriaAlvo, novoLimiteCat);
            await sock.sendMessage(jid, { text: `✅ Teto de gastos para a categoria *${categoriaAlvo}* definido: R$ ${novoLimiteCat.toFixed(2)}` });
            return;
        }

        // --- REGISTRO DE GASTOS (COM PARCELAMENTO) ---
        // Exemplo: gasto 1500 categoria 1/10
        const gastoMatch = texto.match(/^gasto\s+([\d.,]+)\s+(.+?)(?:\s+(\d+)\/(\d+))?$/i);
        if (gastoMatch) {
            const valorTotalInformado = parseFloat(gastoMatch[1].replace(',', '.'));
            let categoriaBase = gastoMatch[2].trim();
            const parcelaInicial = gastoMatch[3] ? parseInt(gastoMatch[3]) : 1;
            const totalParcelas = gastoMatch[4] ? parseInt(gastoMatch[4]) : 1;

            const isParcelado = totalParcelas > 1;
            const valorPorParcela = isParcelado ? (valorTotalInformado / totalParcelas) : valorTotalInformado;
            
            const configGeral = db.prepare('SELECT limite_mensal FROM configuracoes WHERE id = 1').get();
            const configCat = db.prepare('SELECT limite FROM limites_categorias WHERE categoria = ?').get(categoriaBase.toLowerCase());
            
            const gastosMesAtualGeral = db.prepare(`SELECT SUM(valor) as total FROM gastos WHERE data LIKE ?`).get(`${mesAtual}%`).total || 0;
            const gastosMesAtualCat = db.prepare(`SELECT SUM(valor) as total FROM gastos WHERE data LIKE ? AND LOWER(categoria) LIKE ?`).get(`${mesAtual}%`, `${categoriaBase.toLowerCase()}%`).total || 0;

            // Validação de Limites (Geral e Categoria) apenas para o mês atual
            if (configGeral.limite_mensal > 0 && (gastosMesAtualGeral + valorPorParcela) > configGeral.limite_mensal) {
                await sock.sendMessage(jid, { text: `🚫 *Bloqueado!* Esse lançamento estouraria o limite geral do mês.` });
                return;
            }

            if (configCat && (gastosMesAtualCat + valorPorParcela) > configCat.limite) {
                await sock.sendMessage(jid, { text: `⚠️ *Bloqueado!* O teto da categoria *${categoriaBase}* (R$ ${configCat.limite.toFixed(2)}) seria estourado.` });
                return;
            }

            // Loop de inserção no banco de dados para parcelas futuras
            const insertStmt = db.prepare('INSERT INTO gastos (data, valor, categoria, autor) VALUES (?, ?, ?, ?)');
            
            let quantidadeInserida = 0;
            for (let i = 0; i <= (totalParcelas - parcelaInicial); i++) {
                let dataParcela;
                if (i === 0) {
                    dataParcela = dataAtualIso; // Primeira parcela fica com a data exata do momento
                } else {
                    // Fixa no dia 1 para evitar saltos em meses curtos (como Fevereiro)
                    dataParcela = new Date(dataAtual.getFullYear(), dataAtual.getMonth() + i, 1).toISOString();
                }

                const numeroParcelaAtual = parcelaInicial + i;
                const nomeCategoria = isParcelado ? `${categoriaBase} (${numeroParcelaAtual}/${totalParcelas})` : categoriaBase;
                
                insertStmt.run(dataParcela, valorPorParcela, nomeCategoria, identificacaoAutor);
                quantidadeInserida++;
            }

            let resposta = `💸 R$ ${valorTotalInformado.toFixed(2)} em *${categoriaBase}* registrado.\n`;
            if (isParcelado) {
                resposta = `💸 Parcelamento registrado: ${quantidadeInserida}x de R$ ${valorPorParcela.toFixed(2)} em *${categoriaBase}*.\n`;
            }
            
            resposta += `\nAdicionado por: ${identificacaoAutor}`;
            await sock.sendMessage(jid, { text: resposta });
            return;
        }

        // --- RELATÓRIO MENSAL E GERAL ---
        const relatorioMatch = textoLower.match(/^\/relat[oó]rio(?:\s+(.*))?$/);
        if (relatorioMatch) {
            let filtroData = mesAtual;
            let tituloRelatorio = `Resumo do Mês (${mesAtual})`;
            let queryData = `${mesAtual}%`;

            const parametro = relatorioMatch[1] ? relatorioMatch[1].trim() : '';

            if (parametro === 'total') {
                tituloRelatorio = 'Resumo Geral (Todos os Tempos)';
                queryData = '%';
            } else if (parametro.match(/^\d{2}\/\d{4}$/)) { 
                const [mes, ano] = parametro.split('/');
                filtroData = `${ano}-${mes}`;
                tituloRelatorio = `Resumo do Mês (${mes}/${ano})`;
                queryData = `${filtroData}%`;
            } else if (parametro !== '') {
                await sock.sendMessage(jid, { text: `❌ Formato inválido. Use:\n/relatorio\n/relatorio total\n/relatorio MM/AAAA` });
                return;
            }

            const config = db.prepare('SELECT limite_mensal FROM configuracoes WHERE id = 1').get();
            const total = db.prepare(`SELECT SUM(valor) as total FROM gastos WHERE data LIKE ?`).get(queryData).total || 0;
            
            const gastosPorCategoria = db.prepare(`
                SELECT categoria, SUM(valor) as total_cat 
                FROM gastos 
                WHERE data LIKE ? 
                GROUP BY categoria 
                ORDER BY total_cat DESC
            `).all(queryData);

            let msgRelatorio = `*${tituloRelatorio}*\n\n`;
            
            if (parametro !== 'total') {
                msgRelatorio += `💰 *R$ ${total.toFixed(2)} / R$ ${config.limite_mensal.toFixed(2)}*\n`;
                if (config.limite_mensal > 0) {
                    const percentual = ((total / config.limite_mensal) * 100).toFixed(1);
                    msgRelatorio += `📊 ${percentual}% do limite utilizado\n\n`;
                }
            } else {
                msgRelatorio += `💰 *Total Gasto Histórico: R$ ${total.toFixed(2)}*\n\n`;
            }

            msgRelatorio += `*Gastos por Categoria:*\n`;
            if (gastosPorCategoria.length === 0) {
                msgRelatorio += `Nenhum gasto registrado para este período.\n`;
            } else {
                gastosPorCategoria.forEach(g => {
                    msgRelatorio += `- ${g.categoria}: R$ ${g.total_cat.toFixed(2)}\n`;
                });
            }

            await sock.sendMessage(jid, { text: msgRelatorio });
            return;
        }

        // --- COMANDOS BÁSICOS (EXCLUSÃO E LIMITE GERAL) ---
        const limiteMatch = texto.match(/^\/limite\s+([\d.,]+)$/i);
        if (limiteMatch) {
            const novoLimite = parseFloat(limiteMatch[1].replace(',', '.'));
            db.prepare('UPDATE configuracoes SET limite_mensal = ? WHERE id = 1').run(novoLimite);
            await sock.sendMessage(jid, { text: `✅ Limite geral atualizado para R$ ${novoLimite.toFixed(2)}` });
            return;
        }

        if (textoLower === '/excluirregistro') {
            const ultimosGastos = db.prepare('SELECT id, valor, categoria, autor FROM gastos ORDER BY id DESC LIMIT 15').all();
            if (ultimosGastos.length === 0) {
                await sock.sendMessage(jid, { text: 'Nenhum gasto para excluir.' });
                return;
            }
            let msgExcluir = 'Para excluir, envie: */excluir ID*\n\n*Últimos:* \n';
            ultimosGastos.forEach(g => msgExcluir += `[ID: ${g.id}] R$ ${g.valor.toFixed(2)} - ${g.categoria}\n`);
            await sock.sendMessage(jid, { text: msgExcluir });
            return;
        }

        const excluirMatch = texto.match(/^\/excluir\s+(\d+)$/i);
        if (excluirMatch) {
            const id = parseInt(excluirMatch[1]);
            const res = db.prepare('DELETE FROM gastos WHERE id = ?').run(id);
            if (res.changes > 0) await sock.sendMessage(jid, { text: `✅ Registro [ID ${id}] apagado.` });
            return;
        }

        if (textoLower.startsWith('gasto') || textoLower.startsWith('/')) {
            await sock.sendMessage(jid, { text: `❌ Comando inválido.` });
        }
    });
}

startBot();