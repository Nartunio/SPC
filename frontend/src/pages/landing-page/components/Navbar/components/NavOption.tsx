import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuPortal,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { ChevronDown } from "lucide-react";
import { NavLink } from "react-router-dom";
import { Fragment } from "react/jsx-runtime";

export interface NavOptionProps {
    name: string;
    link: string;
    categories?: DropdownCategoryProps[];
}

export interface DropdownCategoryProps {
    name?: string;
    options?: DropdownOptionProps[];
}

export interface DropdownOptionProps {
    name: string;
    link: string;
}

export function NavOption(props: NavOptionProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="cursor-pointer">
          {props.name}
          {props.categories && (<ChevronDown />)}
        </Button>
      </DropdownMenuTrigger>
{props.categories &&
        <DropdownMenuContent className="w-56" align="start">
          {props.categories.map((category, i) => (
            <Fragment key={category.name ?? i}>
              {category.name && (
                <>
                  <DropdownMenuLabel>{category.name}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                </>
              )}
              {category.options && (
                <DropdownMenuGroup>
                  {category.options.map((option) => (
                    <DropdownMenuItem key={option.link} asChild className="cursor-pointer">
                      <NavLink to={option.link}>{option.name}</NavLink>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              )}
            </Fragment>
          ))}
        </DropdownMenuContent>
      }
    </DropdownMenu>
  )
}
