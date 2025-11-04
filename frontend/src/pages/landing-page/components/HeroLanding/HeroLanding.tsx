import React from 'react'

export const HeroLanding = () => {
  return (
    <div className="w-9/10 h-[70vh] mx-auto flex flex-col items-center justify-center text-center">
        <h1 className="text-6xl md:text-8xl font-bold mb-6 font-bitcount text-foreground">Witamy w SPC Drive</h1>
        <p className="text-lg md:text-2xl mb-8 text-muted-foreground max-w-3xl">Twoje kompleksowe rozwiązanie do zarządzania danymi i plikami. Dołącz do nas i odkryj, jak łatwo przesyłać i udostępniać dane!</p>
        <div className="flex space-x-4">
            <button className="bg-foreground text-background px-6 py-3 rounded-md text-lg font-medium hover:bg-foreground/90 transition">Rozpocznij teraz</button>
            <button className="bg-transparent border-2 border-foreground text-foreground px-6 py-3 rounded-md text-lg font-medium hover:bg-foreground hover:text-background transition">Dowiedz się więcej</button>
        </div>
    </div>
  )
}
