// openai.js
import OpenAI from "openai"
import dotenv from "dotenv"
import * as fs from "fs"
import * as path from "path"
import * as url from "url"

dotenv.config()

// ========= BASE DE ARQUIVOS POR RESTAURANTE =========
const RESTAURANT_ID = process.env.RESTAURANT_ID || "default"

// __dirname em módulo ES
const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
const RESTAURANTS_DIR = path.join(__dirname, "restaurants")

let cachedConfig = null
let cachedCardapio = null
let cachedTaxas = null

function loadJsonSafe(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Arquivo ${label} não encontrado em: ${filePath}`)
  }
  const raw = fs.readFileSync(filePath, "utf-8")
  return JSON.parse(raw)
}

function loadRestaurantData() {
  if (cachedConfig && cachedCardapio && cachedTaxas) {
    return { config: cachedConfig, cardapio: cachedCardapio, taxas: cachedTaxas }
  }

 const base = path.join(RESTAURANTS_DIR, RESTAURANT_ID)

  const configPath = path.join(base, "config.json")
  const cardapioPath = path.join(base, "cardapio.json")
  const taxasPath = path.join(base, "taxas.json")

  const config = loadJsonSafe(configPath, "config.json")
  const cardapio = loadJsonSafe(cardapioPath, "cardapio.json")
  const taxas = loadJsonSafe(taxasPath, "taxas.json")

  cachedConfig = config
  cachedCardapio = cardapio
  cachedTaxas = taxas

  return { config, cardapio, taxas }
}

// Pequeno helper para o index.js pegar o nome do restaurante
export function getRestaurantInfo() {
  const { config } = loadRestaurantData()
  return {
    restaurantId: RESTAURANT_ID,
    restaurantName: config.nome || config.restaurante || "MEU RESTAURANTE",
    pixKey: config.pix_key || "",
  }
}

// ========= CLIENTE OPENAI =========
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
})

// ========= FUNÇÃO PRINCIPAL DO AGENTE =========
export async function chamarAgenteIA({
  nomeCliente,
  historico = [],
  mensagemUsuario,
  houveComprovantePix = false,
}) {
  const { config, cardapio, taxas } = loadRestaurantData()
    const formasPagamento = Array.isArray(config.formas_pagamento) && config.formas_pagamento.length
    ? config.formas_pagamento
    : ["PIX"]

  const formasPagamentoTexto = formasPagamento.join(", ")


  // Transformar cardápio JSON em texto resumido para ajudar o modelo
  const cardapioTexto = cardapio.categorias
    .map((cat) => {
      const itens = cat.itens
        .map(
          (i) =>
            `- [${i.codigo}] ${i.nome} — R$ ${i.preco.toFixed(2).replace(".", ",")}${
              i.descricao ? " — " + i.descricao : ""
            }`,
        )
        .join("\n")
      return `🍽️ ${cat.nome}:\n${itens}`
    })
    .join("\n\n")

  const taxasTexto = taxas.bairros
    .map((b) => `- ${b.nome}: R$ ${b.taxa.toFixed(2).replace(".", ",")}`)
    .join("\n")

  const systemContent = `
Você é um *AGENTE DE ATENDIMENTO DE RESTAURANTE* pelo WhatsApp.

--- DADOS DO RESTAURANTE ---
Nome: ${config.nome}
Cidade: ${config.cidade || "não informado"}
Horário de funcionamento: ${config.horario_abertura} às ${config.horario_fechamento}
Observações gerais: ${config.observacoes_gerais || "sem observações especiais"}

--- PAGAMENTO ---
Formas de pagamento aceitas pelo restaurante: ${formasPagamentoTexto}.

- Nunca diga que o restaurante aceita "apenas PIX" a menos que a lista de formas de pagamento tenha somente "PIX".
- Se o cliente perguntar se aceita alguma forma (ex.: "aceita crédito?", "pode ser dinheiro?", "vale refeição?"),
  responda com base nessa lista.
- Se o cliente pedir uma forma que NÃO está na lista (ex.: boleto),
  responda educadamente que no momento não trabalham com essa forma e ofereça as que estão na lista.

--- REGRAS ESPECÍFICAS SOBRE PIX (IMPORTANTÍSSIMO) ---
Chave PIX oficial: ${config.pix_key}
Nome do recebedor: ${config.pix_recebedor || "Restaurante"}
Mensagem padrão após pagamento: ${config.pix_mensagem}

1. Sempre que o cliente:
   - disser que quer pagar no PIX
   - perguntar sobre PIX
   - ou escolher PIX como forma de pagamento,
   você deve OBRIGATORIAMENTE enviar a chave PIX em DUAS LINHAS:

   Linha 1: "Para pagamento via PIX, use a chave abaixo:"
   Linha 2: "${config.pix_key}"

   ⚠ A segunda linha deve conter APENAS a chave PIX, sem texto antes nem depois,
   para o cliente conseguir copiar e colar com facilidade.

2. Depois disso, você pode complementar com instruções, por exemplo:
   "${config.pix_mensagem}"

3. Se o sistema avisar que o cliente enviou um comprovante de PIX,
   responda confirmando o recebimento e dizendo que o pedido será encaminhado.

--- ÁREA DE ENTREGA E TAXAS ---
Bairros atendidos e taxas de entrega:
${taxasTexto}

Se o cliente informar um bairro fora dessa lista, diga que no momento não atendem essa região e seja educado(a).
Se tiver dúvida, peça confirmação do bairro.

--- CARDÁPIO ---
O cardápio completo é:
${cardapioTexto}

*REGRAS DO CARDÁPIO:*
1. Nunca invente itens que não existam nessa lista.
2. Você pode sugerir itens similares, mas sempre dentro do cardápio.
3. Quando o cliente pedir algo, confirme:
   - item
   - quantidade
   - sabor (se fizer sentido)
   - bebida
4. Sempre que possível, monte um *resumo do pedido* e um *total aproximado*.

--- ESTILO DE ATENDIMENTO ---
- Fale sempre em português do Brasil.
- Seja educado(a), direto(a) e objetivo(a).
- Use o nome do cliente assim que ele for informado: "${nomeCliente || "ainda não informado"}".
- Se o cliente mandar só "oi", "boa tarde", etc., dê boas-vindas usando a mensagem:
  "${config.mensagem_boas_vindas}"
  e pergunte nome e bairro.
  `

  let userContent = mensagemUsuario

  if (houveComprovantePix) {
    userContent = `O cliente acabou de enviar um *comprovante de pagamento* (imagem ou documento) e escreveu: "${mensagemUsuario}". Responda confirmando o recebimento, de forma educada, seguindo as regras de PIX e reforçando o resumo do pedido se fizer sentido.`
  }

  const messages = [
    { role: "system", content: systemContent },
    ...historico,
    { role: "user", content: userContent },
  ]

  const resp = await client.responses.create({
    model: "gpt-4.1-mini",
    input: messages,
  })

  const output = resp.output[0].content[0].text
  return output
}
