// Sample disorder, treatment and clinic records used by the Jest tests.
import { DisorderTile } from './components/model-tiles/OverviewTiles/DisorderTile.js';
import { TreatmentTile } from './components/model-tiles/OverviewTiles/TreatmentTile.js';
import { ClinicTile } from './components/model-tiles/OverviewTiles/ClinicTile.js';

export const disorderData = {
    title: 'Disorders',
    tile: DisorderTile,
    data: [
      {
        name: 'Social anxiety disorder',
        description: 'Social anxiety disorder (SAD), also known as social phobia, is an anxiety disorder characterized by sentiments of fear and anxiety in social situations, causing considerable distress and impairing ability to function in at least some aspects of daily life.:\u200a15\u200a These fears can be triggered by perceived or actual scrutiny from others. Individuals with social anxiety disorder fear negative evaluations from other people.Physical symptoms often include excessive blushing, excessive sweating, trembling, palpitations, and nausea. Stammering may be present, along with rapid speech. Panic attacks can also occur under intense fear and discomfort. Some affected individuals may use alcohol or other drugs to reduce fears and inhibitions at social events. It is common for those with social phobia to self-medicate in this fashion, especially if they are undiagnosed, untreated, or both; this can lead to alcohol use disorder, eating disorders or other kinds of substance use disorders. SAD is sometimes referred to as an illness of lost opportunities where \"individuals make major life choices to accommodate their illness\". According to ICD-10 guidelines, the main diagnostic criteria of social phobia are fear of being the focus of attention, or fear of behaving in a way that will be embarrassing or humiliating, avoidance and anxiety symptoms. Standardized rating scales can be used to screen for social anxiety disorder and measure the severity of anxiety.The first line of treatment for social anxiety disorder is cognitive behavioral therapy (CBT). Medications such as SSRIs are effective for social phobia, especially paroxetine. CBT is effective in treating this disorder, whether delivered individually or in a group setting. The cognitive and behavioral components seek to change thought patterns and physical reactions to anxiety-inducing situations. The attention given to social anxiety disorder has significantly increased since 1999 with the approval and marketing of drugs for its treatment. Prescribed medications include several classes of antidepressants: selective serotonin reuptake inhibitors (SSRIs), serotonin\u2013norepinephrine reuptake inhibitors (SNRIs), and monoamine oxidase inhibitors (MAOIs). Other commonly used medications include beta blockers and benzodiazepines.',
        causes: 'Researchers and healthcare professionals are still trying to figure out the cause of social anxiety disorder. Social anxiety disorder can sometimes run in families, but researchers aren’t sure why some family members get it and others don’t. Many parts of your brain are involved with fear and anxiety, so social anxiety disorder is a complex condition to study. Researchers are also looking into how stress and environmental factors could contribute to social anxiety.',
        diagnosis: 'ICD-10 defines social phobia as fear of scrutiny by other people leading to avoidance of social situations. Standardized rating scales such as the Social Phobia Inventory, the SPAI-B, Liebowitz Social Anxiety Scale, and the Social Interaction Anxiety Scale can be used to screen for social anxiety disorder and measure the severity of anxiety.',
        symptoms: 'The anxiety symptoms may present as a complaint of blushing, hand tremor, nausea, or urgency of micturition. Symptoms may progress to panic attacks.',
        link: 'https://www.nimh.nih.gov/health/publications/social-anxiety-disorder-more-than-just-shyness',
        info_image: 'https://i.ibb.co/wLHK5FS/Socialanxietyimage1.png',
        tile_image: 'https://i.ibb.co/X7Mqn2X/Socialanxietyimage2.jpg',
        population: 7,
        treatments: [
            {
                name: 'Interpersonal Psychotherapy',
                id: 0
            }, 
            {
                name: 'Cognitive behavioral therapy',
                id: 1
            }, 
        ],
        clinics: [
            {
                name: 'The Counseling and Mental Health Center (CMHC)',
                id: 1
            }, 
            {
                name: 'Foresight Mental Health',
                id: 2
            }, 
        ]
      },
      {
        name: 'Binge eating disorder',
        description: 'Binge eating disorder (BED) is an eating disorder characterized by frequent and recurrent binge eating episodes with associated negative psychological and social problems, but without the compensatory behaviors common to bulimia nervosa, OSFED, or the binge-purge subtype of anorexia nervosa.BED is a recently described condition, which was required to distinguish binge eating similar to that seen in bulimia nervosa but without characteristic purging. Individuals who are diagnosed with bulimia nervosa and binge eating disorder exhibit similar patterns of compulsive overeating, neurobiological features of dysfunctional cognitive control and food addiction, and biological and environmental risk factors. Some professionals consider BED to be a milder form of bulimia with the two conditions on the same spectrum.Binge eating is one of the most prevalent eating disorders among adults, though there tends to be less media coverage and research about the disorder in comparison to anorexia nervosa and bulimia nervosa.',
        causes: 'The causes of binge-eating disorder are unknown. But genetics, biological factors, long-term dieting and psychological issues increase your risk.',
        diagnosis: 'The 2017 update to the American version of the ICD-10 includes BED under F50.81. ICD-11 may contain a dedicated entry (6B62), defining BED as frequent, recurrent episodes of binge eating (once a week or more over a period of several months) which are not regularly followed by inappropriate compensatory behaviors aimed at preventing weight gain.',
        symptoms: 'Binge eating episodes in BED are generally described as having the following potential features: eating much faster than normal, eating until feeling uncomfortably full, eating a large amount when not hungry, subjective loss of control over how much or what is eaten, planning and allocating specific times for binging, eating alone or secretly, not being able to remember what was eaten after the binge, feelings of guilt, shame or disgust following a food binge, or body image disturbance',
        link: 'https://www.nationaleatingdisorders.org/learn/by-eating-disorder/bed',
        info_image: 'https://i.ibb.co/4R8pbxM/bingeimage2.jpg',
        tile_image: 'https://i.ibb.co/x2LxfKN/bingeimage1.jpg',
        population: 5.5,
        treatments: [
            {
                name: 'Interpersonal Psychotherapy',
                id: 0
            }, 
            {
                name: 'Cognitive behavioral therapy',
                id: 1
            }, 
            {
                name: 'Detoxification',
                id: 2
            }, 
        ],
        clinics: [
            {
                name: 'Ascension Medical Group Seton Behavioral Health',
                id: 0
            }, 
            {
                name: 'The Counseling and Mental Health Center (CMHC)',
                id: 1
            }, 
            {
                name: 'Foresight Mental Health',
                id: 2
            }, 
        ]
      },
      {
        name: 'Addiction',
        description: 'Addiction is generally a neuropsychological disorder defining pervasive and intense urge to engage in maladaptive behaviors providing immediate sensory rewards (e.g. consuming drugs, excessively gambling), despite their harmful consequences. Dependence is generally an addiction that can involve withdrawal issues. Addictive disorder is a category of mental disorders defining important intensities of addictions or dependences, which induce functional disabilities. There are no agreed definitions on these terms \u2013 see section on definitions.Repetitive drug use alters brain function in ways that perpetuate craving, and weakens (but does not completely negate) self-control. This phenomenon \u2013 drugs reshaping brain function \u2013 has led to an understanding of addiction as a brain disorder with a complex variety of psychosocial as well as neurobiological (and thus involuntary) factors that are implicated in addictions development.Classic signs of addiction include compulsive engagement in rewarding stimuli, preoccupation with substances or behavior, and continued use despite negative consequences. Habits and patterns associated with addiction are typically characterized by immediate gratification (short-term reward), coupled with delayed deleterious effects (long-term costs).Examples of drug (or more generally, substance) addictions include alcoholism, marijuana addiction, amphetamine addiction, cocaine addiction, nicotine addiction, opioid addiction, and eating or food addiction. Alternatively, behavioral addictions may include gambling addiction, internet addiction, social media addiction, video game addiction and sexual addiction. The DSM-5 and ICD-10 only recognise gambling addictions as behavioural addictions, but the ICD-11 also recognises gaming addictions.',
        causes: 'Factors such as peer pressure, physical and sexual abuse, early exposure to drugs, stress, and parental guidance can greatly affect a persons likelihood of drug use and addiction. Development. Genetic and environmental factors interact with critical developmental stages in a persons life to affect addiction risk.',
        diagnosis: 'The Addictions Neuroclinical Assessment is used to diagnose addiction disorders. This tool measures three different domains: executive function, incentive salience, and negative emotionality. Executive functioning consists of processes that would be disrupted in addiction. In the context of addiction, incentive salience determines how one perceives the addictive substance. Increased negative emotional responses have been found with individuals with addictions.',
        symptoms: 'Signs and symptoms of addiction can vary depending on the type of addiction. Symptoms of drug addictions may include: continuation of drug use despite the knowledge of consequences, disregarding financial status when it comes to drug purchases, ensuring a stable supply of the drug, experiencing withdrawal symptoms when stopping the drug, needing more of the drug over time to achieve similar effects, social and work life impacted due to drug use, unsuccessful attempts to stop drug use, and an urge to use drug regularly',
        link: 'https://nida.nih.gov/publications/drugs-brains-behavior-science-addiction/drug-misuse-addiction',
        info_image: 'https://i.ibb.co/SK1sDdR/addicationimage1.jpg',
        tile_image: 'https://i.ibb.co/Tr2cDJ8/addicationimage2.jpg',
        population: 20,
        treatments: [
            {
                name: 'Interpersonal Psychotherapy',
                id: 0
            }, 
            {
                name: 'Cognitive behavioral therapy',
                id: 1
            }, 
            {
                name: 'Detoxification',
                id: 2
            }, 
        ],
        clinics: [
            {
                name: 'Ascension Medical Group Seton Behavioral Health',
                id: 0
            }, 
            {
                name: 'The Counseling and Mental Health Center (CMHC)',
                id: 1
            }, 
            {
                name: 'Foresight Mental Health',
                id: 2
            }, 
        ]
      }
    ]
}
  
export const treatmentData = {
    title: 'Treatments',
    tile: TreatmentTile,
    data: [
      {
        name: 'Interpersonal Psychotherapy',
        description: 'Interpersonal psychotherapy (IPT) is a brief, attachment-focused psychotherapy that centers on resolving interpersonal problems and symptomatic recovery. It is an empirically supported treatment (EST) that follows a highly structured and time-limited approach and is intended to be completed within 12–16 weeks. IPT is based on the principle that relationships and life events impact mood and that the reverse is also true. IPT is an empirically validated intervention for depressive disorders, and is more effective when used in combination with psychiatric medications. Along with cognitive behavioral therapy (CBT), IPT is recommended in treatment guidelines as a psychosocial treatment of choice for depression.',
        type: 'Psychotherapy',
        date_of_creation: '1970s',
        instructions: 'The first step is to assess the problem. This usually involves meeting with the therapist for an initial assessment. The second step is to identify the patterns of behavior that are contributing to the problem. This may involve exploring your childhood experiences, looking at how you relate to others, and identifying any negative thought patterns or beliefs that may be affecting your mental health. The third step is to help you change these patterns of behavior. This usually involves learning new skills and techniques for interacting with others. The fourth and final step is to help you maintain these changes. This usually involves meeting with the therapist on a regular basis to review your progress and ensure that you are further continuing to use the skills and techniques you have learned.',
        link: 'https://mantracare.org/therapy/therapy-types/interpersonal-therapy/#What_Are_The_Steps_Involved_In_IPT_Therapy',
        info_image: 'https://i.ibb.co/C08fBvt/Interpersonal-Psychotherapyimage1.png',
        tile_image: 'https://i.ibb.co/ZmFjqGY/Interpersonal-Psychotherapyimage2.jpg',
        cost: 62,
        disorders: [
            {
                name: 'Social anxiety disorder',
                id: 0
            }, 
            {
                name: 'Binge eating disorder',
                id: 1
            }, 
            {
                name: 'Addiction',
                id: 2
            }, 
        ],
        clinics: [
            {
                name: 'The Counseling and Mental Health Center (CMHC)',
                id: 1
            }, 
            {
                name: 'Foresight Mental Health',
                id: 2
            }, 
        ]
      },
      {
        name: 'Cognitive behavioral therapy',
        description: 'Cognitive behavioral therapy (CBT) is a psycho-social intervention that aims to reduce symptoms of various mental health conditions, primarily depression and anxiety disorders. Cognitive behavioral therapy is one of the most effective means of treatment for substance abuse and co-occurring mental health disorders. CBT focuses on challenging and changing cognitive distortions (such as thoughts, beliefs, and attitudes) and their associated behaviors to improve emotional regulation and develop personal coping strategies that target solving current problems. Though it was originally designed to treat depression, its uses have been expanded to include many issues and the treatment of many mental health conditions, including anxiety, substance use disorders, marital problems, ADHD, and eating disorders.',
        type: 'Psychotherapy',
        date_of_creation: '1980s',
        instructions: 'A typical CBT programme would consist of face-to-face sessions between patient and therapist, made up of 6–18 sessions of around an hour each with a gap of 1–3 weeks between sessions. This initial programme might be followed by some booster sessions, for instance after one month and three months. CBT has also been found to be effective if patient and therapist type in real time to each other over computer links.',
        link: 'https://en.m.wikipedia.org/wiki/Cognitive_behavioral_therapy',
        info_image: 'https://i.ibb.co/THXHBK5/Cognitivebehavioraltherapyimage2.jpg',
        tile_image: 'https://i.ibb.co/61qzdmd/Cognitivebehavioraltherapyimage1.jpg',
        cost: 84,
        disorders: [
            {
                name: 'Social anxiety disorder',
                id: 0
            }, 
            {
                name: 'Binge eating disorder',
                id: 1
            }, 
        ],
        clinics: [
            {
                name: 'Ascension Medical Group Seton Behavioral Health',
                id: 0
            }, 
            {
                name: 'The Counseling and Mental Health Center (CMHC)',
                id: 1
            }, 
            {
                name: 'Foresight Mental Health',
                id: 2
            }, 
        ]
      },
      {
        name: 'Detoxification',
        description: 'Detoxification or detoxication (detox for short)[1] is the physiological or medicinal removal of toxic substances from a living organism, including the human body, which is mainly carried out by the liver. Additionally, it can refer to the period of drug withdrawal during which an organism returns to homeostasis after long-term use of an addictive substance. In medicine, detoxification can be achieved by decontamination of poison ingestion and the use of antidotes as well as techniques such as dialysis and (in a limited number of cases) chelation therapy.',
        type: 'Self-Help Plan/Medication',
        date_of_creation: 'N/A',
        instructions: 'Everyone’s detox needs are different. The drug detox process helps addicted people get personalized treatment. In most cases, the process involves 3 steps: evaluation (The medical team screens incoming patients for physical and mental health issues. Doctors use blood tests to measure the amount of drugs in the patient’s system. This helps determine the level of medications needed.), stabilization (The next step is to stabilize the patient with medical and psychological therapy. The goal of stabilization is to prevent any form of harm to the patient.), and preparing entry into treatment (The final step of detox is preparation for a treatment program. Doctors familiarize their patients with the treatment process and what to expect.).',
        link: 'https://www.addictioncenter.com/treatment/drug-and-alcohol-detox/',
        info_image: 'https://i.ibb.co/WtKKQtD/detoximage2.webp',
        tile_image: 'https://i.ibb.co/6mhBG2w/detoximage1.jpg',
        cost: 90,
        disorders: [
            {
                name: 'Binge eating disorder',
                id: 1
            }, 
            {
                name: 'Addiction',
                id: 2
            }, 
        ],
        clinics: [
            {
                name: 'Ascension Medical Group Seton Behavioral Health',
                id: 0
            }, 
            {
                name: 'Foresight Mental Health',
                id: 2
            }, 
        ]
      }
    ] 
}
  
export const clinicData = {
    title: 'Clinics',
    tile: ClinicTile,
    data: [
      {
        name: 'Ascension Medical Group Seton Behavioral Health',
        stars: 2.6,
        location: '1301 W 38th St #700, Austin, TX 78705',
        hours: 'M-F 8am-5pm',
        phoneNumber: 5123243380,
        website: 'https://healthcare.ascension.org',
        info_image: 'https://i.ibb.co/K5J6v6B/ascension-medical-group-location.png',
        tile_image: 'https://i.ibb.co/3YFjjms/ascension-medical-group-logo.png',
        treatments: [
            {
                name: 'Cognitive behavioral therapy',
                id: 1
            }, 
            {
                name: 'Detoxification',
                id: 2
            }, 
        ],
        disorders: [
            {
                name: 'Binge eating disorder',
                id: 1
            }, 
            {
                name: 'Addiction',
                id: 2
            },
        ],
      },
      {
        name: 'The Counseling and Mental Health Center (CMHC)',
        stars: -1,
        location: 'Student Services Building, 100 W Dean Keeton St, Austin, TX 78712',
        hours: 'M-F 8am-5pm',
        phoneNumber: 5124713515,
        website: 'http://cmhc.utexas.edu',
        info_image: 'https://i.ibb.co/y8Kh3DZ/cmhc-location.png',
        tile_image: 'https://i.ibb.co/rtSMFwm/cmhc-logo.webp',
        treatments: [
            {
                name: 'Interpersonal Psychotherapy',
                id: 0
            }, 
            {
                name: 'Cognitive behavioral therapy',
                id: 1
            }, 
        ],
        disorders: [
            {
                name: 'Social anxiety disorder',
                id: 0
            }, 
            {
                name: 'Binge eating disorder',
                id: 1
            }, 
        ],
      },
      {
        name: 'Foresight Mental Health',
        stars: -1,
        location: "1401 Lavaca St, Austin, TX 78701",
        hours: "M-F 9am-6pm",
        phoneNumber: 8885888995,
        website: "https://www.foresightmentalhealth.com/",
        info_image: 'https://i.ibb.co/68yTzRL/foresight-health-location.png',
        tile_image: 'https://i.ibb.co/2NH15YL/foresight-health-logo.png',
        treatments: [
            {
                name: 'Interpersonal Psychotherapy',
                id: 0
            }, 
            {
                name: 'Cognitive behavioral therapy',
                id: 1
            }, 
            {
                name: 'Detoxification',
                id: 2
            }, 
        ],
        disorders: [
            {
                name: 'Social anxiety disorder',
                id: 0
            }, 
            {
                name: 'Binge eating disorder',
                id: 1
            }, 
            {
                name: 'Addiction',
                id: 2
            },
        ],
      }
    ]
}