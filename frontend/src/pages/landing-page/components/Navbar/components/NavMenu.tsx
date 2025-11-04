import React from 'react'
import { NavLink } from 'react-router-dom'

export const NavMenu = () => {
  return (
    <div className="items-center ml-8 flex flex-row">
        <select className="border rounded-lg px-2 py-1 cursor-pointer mr-4">
        <option value={"wybierz opcje"}>wybierz opcje</option>
        <option value={"opcja 1"}>opcja1</option>
        <option value={"opcja 2"}>opcja2</option>
        </select>
        <select className="border rounded-lg px-2 py-1 cursor-pointer">
        <option value={"wybierz opcje"}>wybierz opcje</option>
        <option value={"opcja 1"}>opcja1</option>
        <option value={"opcja 2"}>opcja2</option>
        </select>
        <NavLink to="/menubar" className="border rounded-lg px-2 py-1 cursor-pointer mr-4">Menubar</NavLink>
    </div>
  )
}
