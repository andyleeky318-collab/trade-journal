import { useEffect, useRef, useState } from 'react'
import { listBackups, triggerBackupNow, triggerRestore } from '../lib/api'
import { format, parseISO } from 'date-fns'

function formatSize(bytes) {
  if (!bytes) return '—'
  const mb = bytes / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`
}

export default function BackupPanel({ onClose }) {
  const [backups, setBackups] = useState([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState(null) // tag_name pending confirmation
  const [confirmText, setConfirmText] = useState('')
  const [message, setMessage] = useState(null)
  const pollTimeoutRef = useRef(null)

  const refresh = async () => {
    try {
      const data = await listBackups()
      setBackups(data)
    } catch (err) {
      setMessage(`Could not load backups: ${err.message}`)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
    return () => clearTimeout(pollTimeoutRef.current)
  }, [])

  // After triggering an action, poll every 15s for up to 2 minutes so the
  // panel picks up the new release once the GitHub Action finishes.
  const startPolling = () => {
    let elapsed = 0
    const poll = async () => {
      elapsed += 15000
      await refresh()
      if (elapsed < 120000) {
        pollTimeoutRef.current = setTimeout(poll, 15000)
      }
    }
    pollTimeoutRef.current = setTimeout(poll, 15000)
  }

  const handleBackupNow = async () => {
    setBusy(true)
    setMessage(null)
    try {
      await triggerBackupNow()
      setMessage('Backup started — this usually takes a couple minutes.')
      startPolling()
    } catch (err) {
      setMessage(`Could not start backup: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  const handleRestoreConfirm = async (tagName) => {
    if (confirmText !== 'RESTORE') return
    setBusy(true)
    setMessage(null)
    try {
      await triggerRestore(tagName)
      setMessage(`Restore of ${tagName} started.`)
      setRestoreTarget(null)
      setConfirmText('')
      startPolling()
    } catch (err) {
      setMessage(`Could not start restore: ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="backup-panel-overlay" onClick={onClose}>
      <div className="backup-panel" onClick={(e) => e.stopPropagation()}>
        <div className="backup-panel-header">
          <h3>Backups</h3>
          <button className="backup-panel-close" onClick={onClose}>×</button>
        </div>
        <p className="backup-panel-version">v1.7</p>

        <div className="backup-panel-actions">
          <button onClick={handleBackupNow} disabled={busy}>
            {busy ? 'Working…' : 'Back Up Now'}
          </button>
          <button className="backup-refresh-btn" onClick={refresh} disabled={loading}>
            Refresh
          </button>
        </div>

        {message && <p className="backup-message">{message}</p>}

        {loading ? (
          <p className="loading-note">Loading…</p>
        ) : backups.length === 0 ? (
          <p className="empty-note">No backups yet.</p>
        ) : (
          <ul className="backup-list">
            {backups.map((b) => (
              <li key={b.id} className="backup-list-item">
                <div className="backup-list-meta">
                  <span className="backup-date">
                    {b.published_at ? format(parseISO(b.published_at), 'MMM d, yyyy h:mm a') : b.tag_name}
                  </span>
                  <span className="backup-size">{formatSize(b.size_bytes)}</span>
                </div>

                {restoreTarget === b.tag_name ? (
                  <div className="backup-restore-confirm">
                    <input
                      type="text"
                      placeholder='Type "RESTORE" to confirm'
                      value={confirmText}
                      onChange={(e) => setConfirmText(e.target.value)}
                    />
                    <button
                      className="backup-restore-confirm-btn"
                      disabled={confirmText !== 'RESTORE' || busy}
                      onClick={() => handleRestoreConfirm(b.tag_name)}
                    >
                      Confirm Restore
                    </button>
                    <button
                      className="backup-restore-cancel-btn"
                      onClick={() => {
                        setRestoreTarget(null)
                        setConfirmText('')
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    className="backup-restore-btn"
                    onClick={() => setRestoreTarget(b.tag_name)}
                    disabled={busy}
                  >
                    Restore
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
