import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router-dom'
import { AuthProvider, useAuth } from './lib/AuthContext'
import Login from './pages/Login'
import Calendar from './pages/Calendar'
import DayDetail from './pages/DayDetail'
import Analytics from './pages/Analytics'

function RequireAuth({ children }) {
  const { user, loading } = useAuth()
  if (loading) return <p className="loading-note">Loading…</p>
  if (!user) return <Navigate to="/login" replace />
  return children
}

function NavBar() {
  const { user, signOut } = useAuth()
  if (!user) return null
  return (
    <nav className="top-nav">
      <Link to="/" className="brand">Trade Journal</Link>
      <div className="nav-links">
        <Link to="/analytics">Analytics</Link>
        <button className="signout-btn" onClick={signOut}>Sign out</button>
      </div>
    </nav>
  )
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<RequireAuth><Calendar /></RequireAuth>} />
      <Route path="/day/:date" element={<RequireAuth><DayDetail /></RequireAuth>} />
      <Route path="/analytics" element={<RequireAuth><Analytics /></RequireAuth>} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <AuthProvider>
        <NavBar />
        <main className="app-main">
          <AppRoutes />
        </main>
      </AuthProvider>
    </BrowserRouter>
  )
}
