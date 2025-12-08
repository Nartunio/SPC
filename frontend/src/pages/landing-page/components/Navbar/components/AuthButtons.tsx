import { Button } from '@/components/ui/button'
import { NavLink, Link } from 'react-router-dom'

export const AuthButtons = () => {
  return (
    <div className="flex flex-row">
        <Link to="http://127.0.0.1:8000/login">
            <Button variant="outline" className="mr-4 cursor-pointer">Logowanie</Button>
        </Link>
        <NavLink to="/signup">
            <Button variant="default" className="cursor-pointer">Rejestracja</Button>
        </NavLink>
    </div>
  )
}
