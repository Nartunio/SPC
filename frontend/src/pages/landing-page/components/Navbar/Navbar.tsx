import { Button } from "@/components/ui/button";

const Navbar = () => {

  return <>
    <div className="flex flex-row justify-between items-center px-8 py-4 w-9/10 shadow-xl rounded-lg mx-auto my-8 ring-accent ring-2">
      <div className="">SPC-2025</div>
      <div className="nav"></div>
      <div className="auth-buttons">
        <Button variant="outline" className="mr-4">Logowanie</Button>
        <Button variant="default" className="">Rejestracja</Button>
      </div>
    </div>
  </>  
}

export default Navbar;