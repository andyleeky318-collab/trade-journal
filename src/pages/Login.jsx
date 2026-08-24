import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../lib/AuthContext'

const MAX_OTP_LENGTH = 10
const MIN_OTP_LENGTH = 6

export default function Login() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState('email')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (user) navigate('/', { replace: true })
  }, [user, navigate])

  const handleSendCode = async (e) => {
    e.preventDefault()
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.signInWithOtp({ email })
    setLoading(false)
    if (error) setError(error.message)
    else setStep('code')
  }

  const handleVerifyCode = async (e) => {
    e.preventDefault()
    if (loading) return
    setLoading(true)
    setError(null)
    const { error } = await supabase.auth.verifyOtp({
      email,
      token: code,
      type: 'email',
    })
    setLoading(false)
    if (error) setError(error.message)
  }

  const handleCodeChange = (e) => {
    const digitsOnly = e.target.value.replace(/\D/g, '').slice(0, MAX_OTP_LENGTH)
    setCode(digitsOnly)
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <h1>Trade Journal</h1>
        {step === 'email' && (
          <>
            <p className="auth-sub">Enter your email to get a sign-in code.</p>
            <form onSubmit={handleSendCode}>
              <input
                type="email"
                required
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <button type="submit" disabled={loading}>
                {loading ? 'Sending…' : 'Send code'}
              </button>
            </form>
          </>
        )}
        {step === 'code' && (
          <>
            <p className="auth-sub">Enter the code sent to {email}.</p>
            <form onSubmit={handleVerifyCode}>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                required
                maxLength={MAX_OTP_LENGTH}
                placeholder="Sign-in code"
                value={code}
                onChange={handleCodeChange}
              />
              <button type="submit" disabled={loading || code.length < MIN_OTP_LENGTH}>
                {loading ? 'Verifying…' : 'Verify & sign in'}
              </button>
            </form>
            <button
              type="button"
              className="auth-resend"
              onClick={() => {
                setStep('email')
                setCode('')
                setError(null)
              }}
            >
              Use a different email
            </button>
          </>
        )}
        {error && <p className="auth-error">{error}</p>}
      </div>
    </div>
  )
}
