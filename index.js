// index.js
// Gateway WhatsApp (Baileys) + Agente de IA (OpenAI)

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
} from "@whiskeysockets/baileys"
import qrcode from "qrcode-terminal"
import pino from "pino"
import * as fs from "fs"
import * as path from "path"
import dotenv from "dotenv"
import { chamarAgenteIA, getRestaurantInfo } from "./openai.js"


dotenv.config()

console.log("Booting bot IA...")

const AUTH_DIR = path.resolve("./auth")
const { restaurantName } = getRestaurantInfo()
const RESTAURANT_NAME = restaurantName || "MEU RESTAURANTE"


// guarda contexto de conversa por cliente
const sessions = new Map()

function getSession(jid) {
  if (!sessions.has(jid)) {
    sessions.set(jid, {
      nomeCliente: null,
      historico: [], // [{role, content}]
    })
  }
  return sessions.get(jid)
}

async function start() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR)
  const { version } = await fetchLatestBaileysVersion()
  const logger = pino({ level: "warn" })

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: true, // aviso de deprecated pode ignorar por enquanto
    browser: ["JuBot-IA", "Chrome", "1.0"],
  })

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log("\nEscaneie este QR no seu WhatsApp Business:")
      qrcode.generate(qr, { small: true })
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      console.log("Conexão fechada. Code:", code, "Reconnect =", shouldReconnect)
      if (shouldReconnect) start()
      else console.log('Sessão encerrada. Apague a pasta "auth" e rode de novo para parear.')
    }

    if (connection === "open") {
      console.log("✅ Conectado ao WhatsApp!")
      console.log(`Atendente IA do restaurante "${RESTAURANT_NAME}" pronto.`)
    }
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("messages.upsert", async (m) => {
    try {
      const msg = m.messages?.[0]
      if (!msg || msg.key.fromMe) return

      const jid = jidNormalizedUser(msg.key.remoteJid)

      const body =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.documentMessage?.caption ||
        ""

      const hasMedia =
        !!msg.message?.imageMessage ||
        !!msg.message?.documentMessage

      const textoUsuario = (body || "").trim()

      const session = getSession(jid)

      // salva histórico curto (para não ficar gigante)
      const historicoCurto = session.historico.slice(-10)

      // Regra simples: se o cliente escrever claramente "me chamo X" ou "meu nome é X",
      // tenta salvar o nome na sessão.
      const nomeMatch = textoUsuario.toLowerCase().match(/meu nome é (.+)|me chamo (.+)/)
      if (nomeMatch) {
        const nomeBruto = nomeMatch[1] || nomeMatch[2]
        if (nomeBruto) {
          session.nomeCliente = nomeBruto.trim()
        }
      }

      // registra mensagem do usuário no histórico
      session.historico.push({ role: "user", content: textoUsuario || "[mensagem vazia]" })

      // chama agente de IA
      const resposta = await chamarAgenteIA({
        nomeCliente: session.nomeCliente,
        historico: historicoCurto,
        mensagemUsuario: textoUsuario || "(sem texto, apenas mídia)",
        houveComprovantePix: hasMedia, // se tiver imagem/doc, agente sabe que é comprovante
      })

      // guarda resposta no histórico
      session.historico.push({ role: "assistant", content: resposta })

      await sock.sendMessage(jid, { text: resposta })
    } catch (err) {
      console.error("[handler error]", err?.message || err)
    }
  })

  return sock
}

start().catch((e) => console.error("Falha ao iniciar:", e))
