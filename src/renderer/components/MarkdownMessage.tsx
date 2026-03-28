import React, { useState, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)
  const copy = useCallback(() => {
    navigator.clipboard.writeText(code)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [code])

  return (
    <div className="md-code-block">
      <div className="md-code-header">
        <span className="md-code-lang">{lang}</span>
        <button className="md-copy-btn" onClick={copy}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      <SyntaxHighlighter
        style={oneDark}
        language={lang}
        PreTag="div"
        customStyle={{
          margin: 0,
          borderRadius: '0 0 var(--radius-sm) var(--radius-sm)',
          fontSize: 12,
          lineHeight: 1.6,
          padding: '12px 14px',
          background: 'hsl(220 20% 6%)',
          overflowX: 'auto',
          maxWidth: '100%',
        }}
        codeTagProps={{ style: { fontFamily: 'var(--font-mono)' } }}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  )
}

export function MarkdownMessage({ content }: { content: string }) {
  return (
    <ReactMarkdown
      className="md-body selectable-text"
      remarkPlugins={[remarkGfm]}
      components={{
        // Code blocks and inline code
        code({ className, children, ...props }: any) {
          const match = /language-(\w+)/.exec(className || '')
          const inline = !match && !String(children).includes('\n')
          const codeStr = String(children).replace(/\n$/, '')
          if (!inline && match) {
            return <CodeBlock lang={match[1]} code={codeStr} />
          }
          if (!inline && !match && codeStr.includes('\n')) {
            return <CodeBlock lang="text" code={codeStr} />
          }
          return (
            <code className="md-inline-code" {...props}>{children}</code>
          )
        },
        pre({ children }: any) {
          return <>{children}</>
        },
        // Links — open externally
        a({ href, children }: any) {
          return (
            <a
              href="#"
              onClick={(e) => { e.preventDefault(); if (href) window.canvas.openExternal(href) }}
              className="md-link"
            >
              {children}
            </a>
          )
        },
        // Headings
        h1: ({ children }: any) => <h1 className="md-h1">{children}</h1>,
        h2: ({ children }: any) => <h2 className="md-h2">{children}</h2>,
        h3: ({ children }: any) => <h3 className="md-h3">{children}</h3>,
        h4: ({ children }: any) => <h4 className="md-h4">{children}</h4>,
        // Paragraphs
        p: ({ children }: any) => <p className="md-p">{children}</p>,
        // Lists
        ul: ({ children }: any) => <ul className="md-ul">{children}</ul>,
        ol: ({ children }: any) => <ol className="md-ol">{children}</ol>,
        li: ({ children }: any) => <li className="md-li">{children}</li>,
        // Blockquote
        blockquote: ({ children }: any) => <blockquote className="md-blockquote">{children}</blockquote>,
        // Table
        table: ({ children }: any) => <div className="md-table-wrapper"><table className="md-table">{children}</table></div>,
        th: ({ children }: any) => <th className="md-th">{children}</th>,
        td: ({ children }: any) => <td className="md-td">{children}</td>,
        // HR
        hr: () => <hr className="md-hr" />,
        // Strong / em
        strong: ({ children }: any) => <strong className="md-strong">{children}</strong>,
        em: ({ children }: any) => <em className="md-em">{children}</em>,
      }}
    >
      {content}
    </ReactMarkdown>
  )
}
