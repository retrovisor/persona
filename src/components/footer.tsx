import { PiEnvelope, PiXLogo } from 'react-icons/pi'

 
const Footer = () => {
  return (
    <div className="flex-center w-full flex-col gap-14 bg-[#0E0E0E] px-6 py-14 text-center text-white">
       
      <div>
        <div className="flex-center flex-col gap-6 md:flex-row md:gap-8">
          <a
            href="mailto:hello@aa.ai"
            target="_blank"
            className="flex-center gap-2 text-white">
            <PiEnvelope size={18} />
            Email us
          </a>

 
          <a
            href="https://x.com/wordware_ai"
            target="_blank"
            className="flex-center gap-2 text-white">
            <PiXLogo size={18} />X (fka. Twitter)
          </a>

           
        </div>
      </div>
      <p className="text-xs">Copyright © 2024 </p>
    </div>
  )
}

export default Footer
