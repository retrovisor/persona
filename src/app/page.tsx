import { Suspense } from 'react'
import { PiXLogo } from 'react-icons/pi'

import NewPairFormBothNames from '@/components/new-pair-form-both-names'
import NewUsernameForm from '@/components/new-username-form'
 
import TopList from './top-list'

export const maxDuration = 181

const Page = () => {
  return (
    <section>
      <div className="flex flex-col md:flex-row">
        <div className="relative flex min-h-screen flex-col justify-center bg-[#F9FAFB] p-8 sm:p-12 md:w-1/2 md:p-16 lg:p-24">
         
          <div className="grow" />

          <div>
            <div>
              <h1 className="mb-8 text-4xl md:text-5xl 2xl:text-6xl">
                discover your <br />
                <span
                  className="bg-clip-text text-transparent"
                  style={{ backgroundColor: '#CB9F9F' }}>
                  {' '}
                  twitter{' '}
                </span>
                personality 🔥
              </h1>

              <div className="mb-8 flex w-full flex-col pt-2">
                <div className="flex w-full items-center">
                  <Suspense>
                    <NewUsernameForm />
                  </Suspense>
                </div>
              </div>
            </div>
            <div className="pt-8">
              <h1 className="mb-8 text-4xl md:text-5xl 2xl:text-6xl">
                check your{' '}
                <span className="inline-flex items-center align-middle">
                  <PiXLogo />
                  <PiXLogo />
                  <PiXLogo />
                </span>
                <br />
                <span
                  className="bg-clip-text text-transparent"
                  style={{ backgroundColor: '#6DB1BF' }}>
                  {' '}
                  compatibility
                </span>{' '}
                💞
              </h1>

              <div className="mb-8 flex w-full flex-col pt-2">
                <div className="flex w-full items-center">
                  <Suspense>
                    <NewPairFormBothNames />
                  </Suspense>
                </div>
              </div>
            </div>

            
          </div>
          <div className="grow" />

          <div className="bottom-6 space-y-3 border-t">
            <div className="flex flex-col gap-2">
              <p className="mt-8 text-sm">
                 
              </p>
              <div className="flex flex-wrap gap-2">
                 
                
              </div>
            </div>
          </div>
        </div>
         
      </div>
      <TopList />
    </section>
  )
}

export default Page
