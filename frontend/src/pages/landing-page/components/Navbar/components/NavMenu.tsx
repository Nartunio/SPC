import React from 'react'
import { NavLink } from 'react-router-dom'
import { NavOption } from './NavOption'

export const NavMenu = () => {
  return (
    <div className="items-center flex flex-row w-min">
        {/* <select className="border rounded-lg px-2 py-1 cursor-pointer mr-4">
        <option value={"wybierz opcje"}>wybierz opcje</option>
        <option value={"opcja 1"}>opcja1</option>
        <option value={"opcja 2"}>opcja2</option>
        </select> */}
        <NavOption name="Start" link="#"/>
        <NavOption name="Funkcje" link="#" categories={[
          {
            options: [
              { name: "Przesyłanie", link: "/features/cloud-storage" },
              { name: "Usuwanie", link: "/features/cloud-storage" },
              { name: "Pobieranie", link: "/features/cloud-storage" },
              { name: "Udostępnianie", link: "/features/cloud-storage" },
            ],
          } 
        ]} />
        <NavOption name="Cennik" link="#"/>
        <NavOption name="Partnerzy" link="#"/>
        <NavOption name="Kontakt" link="#"/>

    </div>
  )
}
