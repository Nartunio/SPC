import Navbar from "./components/Navbar/Navbar";

function LandingPage(){
    return <>
        <div className="w-screen h-screen bg-[url(/public/bg-image1.jpg)] flex flex-col bg-cover bg-center">
             <Navbar />
             <div>
                <main className="flex-1 flex items-center justify-center">
                   <h1 className="text-white text-4xl md:text-6xl drop-shadow-lg">Witamy na stronie</h1>
                </main>
             </div>

        </div>
    </>
}

export default LandingPage;
