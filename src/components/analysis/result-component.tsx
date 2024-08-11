'use client'

import { useCallback } from 'react'
import { useSearchParams } from 'next/navigation'
import posthog from 'posthog-js'

import { SelectUser } from '@/drizzle/schema'
import { useTwitterAnalysis } from '@/hooks/twitter-analysis'

import NewPairForm from '../new-pair-form'
import ActionButtons from './action-buttons'
import { Analysis, TwitterAnalysis } from './analysis'
import { ProgressIndicator, StepIndicator } from './progress-indicator'

const ResultComponent = ({ user }: { user: SelectUser }) => {
  const { steps, result } = useTwitterAnalysis(user)
  const searchParams = useSearchParams()

  const prepareUserData = useCallback((result: TwitterAnalysis | undefined): TwitterAnalysis | undefined => {
    if (!result) return undefined
    return result
  }, [])

  return (
    <div className="flex-center flex-col gap-8">
      <ProgressIndicator
        steps={steps}
        result={result}
        userUnlocked={true}
      />
      <ActionButtons
        shareActive={!!result?.about}
        text={`this is my Twitter Personality analysis by AI Agent, built on @wordware_ai`}
        url={`https://twitter.wordware.ai/${user.username}`}
      />

      <div className="flex-center w-full flex-col gap-4">
        <div className="text-center text-lg font-light">Add new user to find if you are compatible souls</div>
        {steps.wordwareStarted && !steps.wordwareCompleted ? (
          <>
            <div className="mb-2 text-center font-light text-gray-400">Wait for the completion to finish</div>
            <div className="pointer-events-none opacity-50">
              <NewPairForm />
            </div>
          </>
        ) : (
          <NewPairForm />
        )}
      </div>

      <Analysis
        unlocked={true}
        userData={prepareUserData(result)}
      />
      {!result?.loveLife && (
        <StepIndicator
          started={steps.paidWordwareStarted}
          completed={steps.paidWordwareCompleted}
          text="Extending your Personality"
        />
      )}
    </div>
  )
}

export default ResultComponent
