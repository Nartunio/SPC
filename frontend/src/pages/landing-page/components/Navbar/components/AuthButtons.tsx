import { Button } from '@/components/ui/button'
import React from 'react'
import { NavLink } from 'react-router-dom'

export const AuthButtons = () => {
  return (
    <div className="flex flex-row">
        <NavLink to="/login">
            <Button variant="outline" className="mr-4 cursor-pointer">Logowanie</Button>
        </NavLink>
        <NavLink to="/signup">
            <Button variant="default" className="cursor-pointer">Rejestracja</Button>
        </NavLink>
    </div>
  )
}
