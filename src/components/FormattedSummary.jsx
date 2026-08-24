// Renders a small, deliberately-limited subset of markdown coming back from the
// ai-summary / rollup-summary Edge Functions: "## " / "### " headers, "- " / "* "
// bullet lists, "1. " numbered lists, and **bold** inline. No dependency on a
// markdown library — the model is prompted to stick to just these, so a tiny
// hand-rolled parser is enough and keeps things simple.

function renderInline(str, blockKey) {
  const parts = str.split(/(\*\*[^*]+\*\*)/g).filter((p) => p !== '')
  return parts.map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={`${blockKey}-b${i}`}>{part.slice(2, -2)}</strong>
    }
    return <span key={`${blockKey}-s${i}`}>{part}</span>
  })
}

function parseBlocks(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let listBuffer = null // { type: 'ul' | 'ol', items: [] }
  let paraBuffer = []

  const flushPara = () => {
    if (paraBuffer.length) {
      blocks.push({ type: 'p', content: paraBuffer.join(' ').trim() })
      paraBuffer = []
    }
  }
  const flushList = () => {
    if (listBuffer) {
      blocks.push(listBuffer)
      listBuffer = null
    }
  }

  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') {
      flushPara()
      flushList()
      continue
    }
    const h2Match = line.match(/^##\s+(.*)/)
    const h3Match = line.match(/^###\s+(.*)/)
    const ulMatch = line.match(/^[-*]\s+(.*)/)
    const olMatch = line.match(/^\d+[.)]\s+(.*)/)

    if (h2Match) {
      flushPara()
      flushList()
      blocks.push({ type: 'h2', content: h2Match[1] })
      continue
    }
    if (h3Match) {
      flushPara()
      flushList()
      blocks.push({ type: 'h3', content: h3Match[1] })
      continue
    }
    if (ulMatch) {
      flushPara()
      if (!listBuffer || listBuffer.type !== 'ul') {
        flushList()
        listBuffer = { type: 'ul', items: [] }
      }
      listBuffer.items.push(ulMatch[1])
      continue
    }
    if (olMatch) {
      flushPara()
      if (!listBuffer || listBuffer.type !== 'ol') {
        flushList()
        listBuffer = { type: 'ol', items: [] }
      }
      listBuffer.items.push(olMatch[1])
      continue
    }
    flushList()
    paraBuffer.push(line)
  }
  flushPara()
  flushList()
  return blocks
}

export default function FormattedSummary({ text }) {
  if (!text) return null
  const blocks = parseBlocks(text)
  return (
    <div className="ai-summary-formatted">
      {blocks.map((b, i) => {
        if (b.type === 'h2') {
          return (
            <h4 key={i} className="summary-heading">
              {renderInline(b.content, i)}
            </h4>
          )
        }
        if (b.type === 'h3') {
          return (
            <h5 key={i} className="summary-subheading">
              {renderInline(b.content, i)}
            </h5>
          )
        }
        if (b.type === 'ul') {
          return (
            <ul key={i} className="summary-list">
              {b.items.map((item, j) => (
                <li key={j}>{renderInline(item, `${i}-${j}`)}</li>
              ))}
            </ul>
          )
        }
        if (b.type === 'ol') {
          return (
            <ol key={i} className="summary-list">
              {b.items.map((item, j) => (
                <li key={j}>{renderInline(item, `${i}-${j}`)}</li>
              ))}
            </ol>
          )
        }
        return (
          <p key={i} className="summary-paragraph">
            {renderInline(b.content, i)}
          </p>
        )
      })}
    </div>
  )
}
