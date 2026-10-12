import { useState } from 'react'

/** Square, lazy-loaded image with the aspect ratio reserved; a gradient shows when there is no art. */
export function Artwork({ src }: { src?: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <div className="artwork">
      {src && !failed && <img src={src} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />}
    </div>
  )
}
