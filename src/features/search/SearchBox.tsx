import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'

export const SEARCH_PATH = '/library/search'
const DEBOUNCE_MS = 300

export default function SearchBox() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const [value, setValue] = useState(useSearchParams()[0].get('q') ?? '')
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  function onChange(e: ChangeEvent<HTMLInputElement>) {
    const text = e.target.value
    setValue(text)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      const q = text.trim()
      const onSearch = pathname === SEARCH_PATH
      if (!q && !onSearch) return
      navigate(q ? `${SEARCH_PATH}?q=${encodeURIComponent(q)}` : SEARCH_PATH, { replace: onSearch })
    }, DEBOUNCE_MS)
  }

  return (
    <form role="search" className="searchbox" onSubmit={(e) => e.preventDefault()}>
      <input type="search" aria-label="Search library" placeholder="Search" autoComplete="off" value={value} onChange={onChange} />
    </form>
  )
}
