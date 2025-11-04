import { Button } from "@/components/ui/button";
import { Link, NavLink } from "react-router-dom";
import { AuthButtons } from "./components/AuthButtons";
import { Logo } from "./components/Logo";
import { NavMenu } from "./components/NavMenu";

const Navbar = () => {
  return <>
      <div className="flex flex-row justify-between px-8 py-4 w-9/10 shadow-xl rounded-lg mx-auto my-8 ring-accent ring-2 bg-background h-17">
        <Logo />
        <NavMenu />
        <AuthButtons />
      </div>
  </>  
}

export default Navbar;