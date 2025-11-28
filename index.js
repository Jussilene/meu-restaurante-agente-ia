// index.js
// Gateway WhatsApp (Baileys) + Agente de IA (OpenAI)

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import pino from "pino";
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";
import { chamarAgenteIA, getRestaurantInfo } from "./openai.js";
import {
  appendOrder,
  getLastOrderByPhone,
  getStatusForPhone,
  findOrdersNeedingNotification,
  updateNotifiedStatus,
} from "./sheets.js";

dotenv.config();

console.log("Booting bot IA...");

const AUTH_DIR = path.resolve("./auth");
const { restaurantName } = getRestaurantInfo();
const RESTAURANT_NAME = restaurantName || "MEU RESTAURANTE";

// guarda contexto de conversa por cliente
const sessions = new Map();

function getSession(jid) {
  if (!sessions.has(jid)) {
    sessions.set(jid, {
      nomeCliente: null,
      historico: [], // [{role, content}]
      inicializado: false,
      ultimoPedidoPlanilha: null,
      // assinatura do último pedido efetivamente registrado nesta sessão
      ultimaAssinaturaPedidoRegistrado: null,
      // flag para saber se o endereço recorrente já foi confirmado nesta conversa
      enderecoConfirmado: false,
    });
  }
  return sessions.get(jid);
}

// ------------ Notificações automáticas por mudança de status -----------

async function checarMudancasStatusESNotificar(sock) {
  try {
    const pendentes = await findOrdersNeedingNotification();

    if (!pendentes.length) return;

    for (const pedido of pendentes) {
      // 1) tenta usar o JID salvo na planilha (mais confiável)
      let jidDestino = pedido.waJid ? jidNormalizedUser(pedido.waJid) : null;

      // 2) se não tiver JID (linhas antigas), cai no telefone como antes
      if (!jidDestino) {
        let telefone = (pedido.telefone || "").replace(/\D/g, "");
        if (!telefone) continue;

        if (telefone.length === 11) {
          telefone = `55${telefone}`;
        }

        jidDestino = jidNormalizedUser(`${telefone}@s.whatsapp.net`);
      }

      const nome =
        pedido.nome && pedido.nome !== "não informado" ? pedido.nome : "";

      let texto = "";

      if (pedido.status === "ACEITO") {
        texto = nome
          ? `Olá, ${nome}! Seu pedido foi *ACEITO* e já está sendo preparado com todo cuidado na nossa cozinha. Qualquer novidade, avisaremos por aqui.`
          : `Seu pedido foi *ACEITO* e já está sendo preparado com todo cuidado na nossa cozinha. Qualquer novidade, avisaremos por aqui.`;
        await updateNotifiedStatus(pedido.rowNumber, "ACEITO");
      } else if (pedido.status === "SAIU PRA ENTREGA") {
        texto = nome
          ? `Olá, ${nome}! Seu pedido acaba de *SAIR PARA ENTREGA* e logo chegará até você. Desejamos uma ótima refeição e seguimos à disposição sempre que precisar!`
          : `Seu pedido acaba de *SAIR PARA ENTREGA* e logo chegará até você. Desejamos uma ótima refeição e seguimos à disposição sempre que precisar!`;
        await updateNotifiedStatus(pedido.rowNumber, "SAIU PRA ENTREGA");
      } else {
        continue;
      }

      await sock.sendMessage(jidDestino, { text: texto });
    }
  } catch (err) {
    console.error("[status-watcher] erro:", err?.message || err);
  }
}

function iniciarWatcherDeStatus(sock) {
  // Checa a cada 20 segundos
  setInterval(() => {
    checarMudancasStatusESNotificar(sock);
  }, 20000);
}

// ----------------------- Lógica principal do bot -----------------------

async function start() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: "warn" });

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: true,
    browser: ["JuBot-IA", "Chrome", "1.0"],
  });

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\nEscaneie este QR no seu WhatsApp Business:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log("Conexão fechada. Code:", code, "Reconnect =", shouldReconnect);
      if (shouldReconnect) start();
      else
        console.log(
          'Sessão encerrada. Apague a pasta "auth" e rode de novo para parear.'
        );
    }

    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!");
      console.log(`Atendente IA do restaurante "${RESTAURANT_NAME}" pronto.`);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  // Inicia watcher de status da planilha (ACEITO / SAIU PRA ENTREGA)
  iniciarWatcherDeStatus(sock);

  // ------------ atendimento de mensagens do Whats -------------

  sock.ev.on("messages.upsert", async (m) => {
    // 🔎 DEBUG: pra garantir que o evento está chegando
    console.log("🟢 messages.upsert recebido:", JSON.stringify(m.messages?.[0]?.key, null, 2));

    try {
      const msg = m.messages?.[0];
      if (!msg || msg.key.fromMe) return;

      const jid = jidNormalizedUser(msg.key.remoteJid);

      // Normaliza telefone para salvar na planilha (interno)
      const rawTel = (jid.split("@")[0] || "").replace(/\D/g, "");
      let telefone = rawTel;

      // Se vier algo maior (ex: ID estranho), tenta extrair DDD+numero
      if (rawTel.length > 13) {
        const ultimos11 = rawTel.slice(-11); // DDD + 9 dígitos
        telefone = `55${ultimos11}`;
      }

      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        "";

      const hasMedia =
        !!msg.message?.imageMessage || !!msg.message?.documentMessage;

      const textoUsuario = (body || "").trim();
      const textoLower = textoUsuario.toLowerCase();

      console.log("[msg] de", telefone, "->", textoUsuario);

      const session = getSession(jid);

      // Carrega dados da planilha apenas na primeira mensagem dessa sessão
      if (!session.inicializado) {
        session.inicializado = true;
        try {
          const ultimo = await getLastOrderByPhone(telefone);
          if (ultimo) {
            session.ultimoPedidoPlanilha = ultimo;
            if (ultimo.nome && !session.nomeCliente) {
              session.nomeCliente = ultimo.nome;
            }
          }
        } catch (e) {
          console.error(
            "[planilha] erro ao buscar último pedido:",
            e?.message || e
          );
        }
      }

      // salva histórico curto (para não ficar gigante)
      const historicoCurto = session.historico.slice(-10);

      // se a última msg do bot pediu o nome, assume que a resposta é o nome
      const ultimaMsg = historicoCurto[historicoCurto.length - 1];
      if (
        ultimaMsg &&
        ultimaMsg.role === "assistant" &&
        /seu nome|qual o seu nome|como você se chama|me diga seu nome/i.test(
          ultimaMsg.content || ""
        ) &&
        textoUsuario &&
        textoUsuario.length <= 40
      ) {
        session.nomeCliente = textoUsuario.trim();
      }

      // Se o cliente escrever "meu nome é X" ou "me chamo X", tenta salvar o nome
      const nomeMatch = textoLower.match(/meu nome é (.+)|me chamo (.+)/);
      if (nomeMatch) {
        const nomeBruto = nomeMatch[1] || nomeMatch[2];
        if (nomeBruto) {
          session.nomeCliente = nomeBruto.trim();
        }
      }

      // Detecta confirmação de endereço recorrente para não repetir a pergunta
      if (
        ultimaMsg &&
        ultimaMsg.role === "assistant" &&
        /seu endereço e região \(bairro\) continuam como/i.test(
          ultimaMsg.content || ""
        )
      ) {
        const txt = textoLower;
        const confirmouEndereco =
          txt === "sim" ||
          txt.startsWith("sim ") ||
          txt.includes("esse endereço mesmo") ||
          txt.includes("esse mesmo") ||
          txt.includes("isso mesmo") ||
          txt.includes("é esse mesmo") ||
          txt.includes("é isso mesmo") ||
          txt.includes("endereço mesmo") ||
          txt.includes("pode ser esse mesmo") ||
          txt.includes("pode manter esse endereço");

        if (confirmouEndereco) {
          session.enderecoConfirmado = true;
        }
      }

      // --------------- RESPOSTAS CURTINHAS "OK / OBRIGADO" ---------------
      // Se for só agradecimento/ok (mesmo com um "aguardando" ou algo curto depois),
      // responde curto e NÃO chama a IA.
      const palavrasFechamento = [
        "ok",
        "obrigado",
        "obrigada",
        "valeu",
        "vlw",
        "obg",
        "show",
        "beleza",
        "blz",
      ];

      const ehSoFechamento =
        !!textoLower &&
        textoLower.length <= 40 &&
        palavrasFechamento.some((p) => textoLower.startsWith(p));

      if (ehSoFechamento) {
        const respostaCurta =
          "Por nada, estou à disposição para o que precisar. 🙂";
        await sock.sendMessage(jid, { text: respostaCurta });
        session.historico.push({ role: "user", content: textoUsuario });
        session.historico.push({ role: "assistant", content: respostaCurta });
        return;
      }

      // ----------------- PERGUNTAS DE STATUS -----------------
      const perguntaStatus =
        textoLower.includes("status do meu pedido") ||
        (textoLower.includes("status") && textoLower.includes("pedido")) ||
        textoLower.includes("meu pedido tá chegando") ||
        textoLower.includes("meu pedido ta chegando") ||
        textoLower.includes("meu pedido já saiu") ||
        textoLower.includes("meu pedido ja saiu");

      if (perguntaStatus) {
        const pedido = await getLastOrderByPhone(telefone);

        if (!pedido) {
          const texto =
            "Não encontrei nenhum pedido recente para o seu número. Se for seu primeiro pedido hoje, me conta o que você gostaria de pedir que eu te ajudo a montar.";
          await sock.sendMessage(jid, { text: texto });
          session.historico.push({ role: "user", content: textoUsuario });
          session.historico.push({ role: "assistant", content: texto });
          return;
        }

        const status = (pedido.status || "").toUpperCase();
        let respostaStatus = "";

        if (status.startsWith("ACEITO") || status.startsWith("PREPARANDO")) {
          respostaStatus =
            "Seu pedido já foi ACEITO e está em preparo na cozinha. Qualquer novidade te aviso por aqui.";
        } else if (status.startsWith("SAIU PRA ENTREGA")) {
          respostaStatus =
            "Seu pedido já SAIU PARA ENTREGA e está a caminho. Em breve deve chegar aí.";
        } else if (status.startsWith("ENTREGUE")) {
          respostaStatus =
            "O sistema mostra que seu pedido já foi ENTREGUE. Se tiver qualquer problema, me avisa por aqui.";
        } else {
          respostaStatus = `O status atual do seu pedido é: *${pedido.status}*.\nSe precisar de algo, é só chamar aqui.`;
        }

        await sock.sendMessage(jid, { text: respostaStatus });
        session.historico.push({ role: "user", content: textoUsuario });
        session.historico.push({ role: "assistant", content: respostaStatus });
        return;
      }

      // ----------------- Fluxo normal com IA -----------------

      // registra mensagem do usuário no histórico
      session.historico.push({
        role: "user",
        content:
          textoUsuario || (hasMedia ? "(apenas mídia)" : "[mensagem vazia]"),
      });

      const respostaIA = await chamarAgenteIA({
        nomeCliente: session.nomeCliente,
        historico: historicoCurto,
        mensagemUsuario: textoUsuario || (hasMedia ? "(apenas mídia)" : ""),
        houveComprovantePix: hasMedia,
        telefone,
        dadosUltimoPedido: session.ultimoPedidoPlanilha,
        enderecoJaConfirmado: session.enderecoConfirmado,
      });

      // Extrai (se existir) o bloco [[REGISTRAR_PEDIDO]] com JSON
      const regexBloco = /\[\[REGISTRAR_PEDIDO\]\]\s*({[\s\S]*?})/;
      const match = respostaIA.match(regexBloco);

      let respostaParaCliente = respostaIA;
      let dadosPedido = null;

      if (match) {
        const jsonText = match[1].trim();

        // remove o bloco da mensagem que vai pro cliente
        respostaParaCliente = respostaIA.replace(regexBloco, "").trim();

        try {
          dadosPedido = JSON.parse(jsonText);
          console.log("[REGISTRAR_PEDIDO] JSON recebido:", dadosPedido);
        } catch (e) {
          console.error(
            "[parse REGISTRAR_PEDIDO] erro ao fazer JSON.parse:",
            e?.message || e
          );
        }
      }

      // guarda resposta (sem bloco) no histórico
      session.historico.push({
        role: "assistant",
        content: respostaParaCliente,
      });

      // Envia a mensagem da IA pro cliente
      if (respostaParaCliente) {
        await sock.sendMessage(jid, { text: respostaParaCliente });
      }

      // Se tiver vindo bloco para registrar pedido, grava SEMPRE na planilha,
      // mas evita duplicar o MESMO pedido na mesma sessão.
      if (dadosPedido) {
        const nomeFinal =
          dadosPedido.nome || session.nomeCliente || "não informado";

        const order = {
          id: "", // deixa em branco se a planilha controla o ID
          nome: nomeFinal,
          telefone, // interno
          itens: dadosPedido.itens || "",
          total: dadosPedido.total || "",
          status: "PENDENTE CONFIRMACAO",
          regiao: dadosPedido.regiao || "", // bairro/região
          endereco: dadosPedido.endereco || "",
          formaPagamento: dadosPedido.formaPagamento || "",
          observacoes: dadosPedido.observacoes || "",
          origem: dadosPedido.origem || "WhatsApp",
          waJid: jid, // JID real do WhatsApp para notificação
        };

        // assinatura simples para evitar duplicidade
        const assinaturaAtual = [
          order.itens,
          order.total,
          order.endereco,
          order.formaPagamento,
        ].join("|");

        if (session.ultimaAssinaturaPedidoRegistrado === assinaturaAtual) {
          console.log(
            "[planilha] REGISTRAR_PEDIDO ignorado (mesmo pedido já registrado nesta sessão)."
          );
        } else {
          try {
            await appendOrder(order);
            console.log("[planilha] pedido registrado para", telefone);

            // Atualiza memória de último pedido + assinatura
            session.ultimoPedidoPlanilha = {
              ...order,
              rowNumber: null,
            };
            session.ultimaAssinaturaPedidoRegistrado = assinaturaAtual;
          } catch (e) {
            console.error(
              "[planilha] erro ao registrar pedido:",
              e?.message || e
            );
          }
        }
      }
    } catch (err) {
      console.error("[handler error]", err?.message || err);
    }
  });

  return sock;
}

start().catch((e) => console.error("Falha ao iniciar:", e));
