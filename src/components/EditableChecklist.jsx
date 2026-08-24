import { useState } from 'react'

export default function EditableChecklist({ items, selectedIds, onToggle, onAdd, onDelete }) {
  const [newItem, setNewItem] = useState('')
  const selected = new Set(selectedIds)

  const handleAdd = (e) => {
    e.preventDefault()
    const trimmed = newItem.trim()
    if (!trimmed) return
    onAdd(trimmed)
    setNewItem('')
  }

  return (
    <div className="editable-checklist">
      <div className="checklist-items">
        {items.length === 0 && <p className="empty-note">No items yet — add one below.</p>}
        {items.map((item) => (
          <label key={item.id} className="checklist-row">
            <input
              type="checkbox"
              checked={selected.has(item.id)}
              onChange={() => onToggle(item.id)}
            />
            <span>{item.name}</span>
            <button
              type="button"
              className="delete-x"
              title="Remove from list"
              onClick={() => onDelete(item.id)}
            >
              ×
            </button>
          </label>
        ))}
      </div>
      <form className="checklist-add" onSubmit={handleAdd}>
        <input
          type="text"
          placeholder="Add new item…"
          value={newItem}
          onChange={(e) => setNewItem(e.target.value)}
        />
        <button type="submit">Add</button>
      </form>
    </div>
  )
}
