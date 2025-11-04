import { Button } from '@/components/ui/button'
import React from 'react'
import { NavLink } from 'react-router-dom'

export const AuthButtons = () => {
  return (
    <div className="ml-auto flex flex-row">
        <Button variant="outline" className="mr-4 hover:bg-foreground hover:text-white">
        <NavLink to="/login">Logowanie</NavLink>
        </Button>
        <Button variant="default" className="">
        <NavLink to="/signup">Rejestracja</NavLink>
        </Button>
    </div>
  )
}
