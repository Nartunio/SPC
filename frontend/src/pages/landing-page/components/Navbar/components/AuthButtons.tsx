import { Button } from '@/components/ui/button'
import { useAuth0 } from "@auth0/auth0-react";

export const AuthButtons = () => {
  const { loginWithRedirect } = useAuth0();
  return (
    <div className="flex flex-row">
      <Button 
        variant="outline" 
        className="mr-4 cursor-pointer"
        onClick={() => loginWithRedirect()}
      >
        Logowanie
      </Button>
    </div>
  )
}
