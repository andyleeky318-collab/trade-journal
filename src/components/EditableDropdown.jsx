import { useState } from 'react'

export default function EditableDropdown({ label, items, value, onChange, onAdd, onDelete }) {
  const [managing, setManaging] = useState(false)
  const [newItem, setNewItem] = useState('')

  const handleAdd = (e) => {
    e.preventDefault()
    const trimmed = newItem.trim()
    if (!trimmed) return
    onAdd(trimmed)
    setNewItem('')
  }

  return (
    <div className="editable-dropdown">
      <div className="dropdown-row">
        <select value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">— Select {label} —</option>
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        <button type="button" className="manage-btn" onClick={() => setManaging(!managing)}>
          {managing ? 'Done' : 'Manage list'}
        </button>
      </div>
      {managing && (
        <div className="dropdown-manage">
          <ul>
            {items.map((item) => (
              <li key={item.id}>
                {item.name}
                <button type="button" className="delete-x" onClick={() => onDelete(item.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <form onSubmit={handleAdd}>
            <input
              type="text"
              placeholder={`Add new ${label.toLowerCase()}…`}
              value={newItem}
              onChange={(e) => setNewItem(e.target.value)}
            />
            <button type="submit">Add</button>
          </form>
        </div>
      )}
    </div>
  )
}
