// About page: project mission, team cards, data-integration notes, challenges faced and the tools used.
import React, { useEffect, useState } from 'react';
import GitLabStats from './components/about/GitLab.js';
import ToolList from './Tools.js';

/**
 * Renders the About page.
 * @returns {JSX.Element} the page.
 */
export function About() {
  return (
    <div>
      <section className="about">
        <div className="container">
          <div className="row">
            <div className="col-12">
              <h1 className="mt-5 text-center">
                About Mental Health Austin
              </h1>
              <p className='p-3'>
              Mental Health Austin serves as a comprehensive information center, offering insights into treatments, mental health disorders, and clinics in the Austin area. Our mission is to empower the Austin community by providing accessible resources and facilitating awareness of various mental health disorders and available treatments.
              </p>
              <h2 className="text-center">
                Our Team
              </h2>
              <GitLabStats />
              <h2 className="text-center">
                Integrating Disparate Data
              </h2>
              <p className='p-3'>
                We collected data from many different sources, some of which did not use mainstream industry standards. This made it particularly challenging to obtain information. We had some issues in making sure that names and titles for information on these separate sites were correctly bucketed into centralized attributes correctly. Interestingly, we found that we were able to use simple string searches to match these data instances together, and that there were almost two modes with respect to the number of links any one data instance had - i.e. either there were many links, or very few links. We think this is correlated to the reliability of the institutions that host these APIs.
              </p>
              <h2 className="text-center">
                Challenges Faced
              </h2>
              <p className='p-3'>
                One of the greatest difficulties in gathering the data from this project was figuring out where to source information for the various disorders and treatments that are covered
                in Austin.
              </p>
              <ul class="list-group list-group-flush list-group-numbered">
                <li class="list-group-item">Learning how to scrape the APIs
                  <ul>
                    <li>We needed to learn how to use an API to get data, something we didn’t have experience with</li>
                    <li>The API’s of different organizations have the same overarching RESTful structure, but the parameters and documentation are very different.
                      This means changes to the programmatic scraping requires manual lookup of 3rd-party API’s. Furthermore, each API does not have explicit links to different data models.
                      This is an obvious problem, as the 3rd-party API does not know about our design; that said, the challenge of manually/programatically finding links between models was
                      especially difficult. We relied on a mix of text parsing scripts as well as manual work in order to speed up our process.</li>
                  </ul>
                  </li>
                  <li class="list-group-item">Understanding aspects of Postman and how to document an API
                    <ul>
                      <li>None of us have documented using Postman, so we had to follow several tutorials</li>
                      <li>We also have to design the API without being able to test/implement it quite yet, 
                        so it has been challenging determining realistic and practical designs for our API.</li>
                    </ul>
                </li>
              </ul>
              <p className='p-3'>
                Another set of challenges came from using many third-party tools. While some tools like Bootstrap and Gitlab are clear-cut (if mistake-prone), tools like AWS offer
                a different set of challenges. It is a large tool that comes with many options and arguably too much control for new SWE engineers. 
              </p>
              <ul class="list-group list-group-flush list-group-numbered">
                <li class="list-group-item">Identity Management
                  <ul>
                    <li>We struggled with identity management and with getting all our team members access to the correct access levels. For instance, we had team members
                      able to access Amplify Studio separately from the AWS console, which is necessary to configure some domain transfer issues.
                    </li>
                  </ul>
                </li>
                <li class="list-group-item">Domain Management
                  <ul>
                    <li>We also struggled with correctly understanding the difference between several options offered by AWS. Specifically, a domain name transfer is very
                      different from a domain name link or redirect. One is a much longer and involved process than the other.
                    </li>
                  </ul>
                </li>
                <li class="list-group-item">AWS Trailing Slashes
                  <ul>
                    <li>We found that AWS also adds on peculiar, unintuitive behaviors to urls and certain file types. In order to limit certain types of urls and files from
                      being sent to/from the server, AWS adds a trailing slash to urls by default. Without knowing how to deal with these trailing slashes, refreshes may cause
                      404 errors and certain file types, notably jpg, jpeg, webp, and others are blocked from loading.
                    </li>
                  </ul>
                </li>
                <li class="list-group-item">Finding Sufficient Data from APIs
                  <ul>
                    <li>During the scraping period of this phase, there were times when the data we’d receive from an API was not sufficient for our requirements. As a result, we needed to do research to find additional APIs to scrape data from, and this led to us having scattered data, so we needed to programmatically connect data from different JSON files into one location. Solving this issue allowed us to store data in our repository and database in an efficient and uncluttered manner, with the necessary number of attributes.
                    </li>
                  </ul>
                  </li>
                  <li class="list-group-item">HTTPS connections
                  <ul>
                    <li>
                    We wanted to enable secure connections to our API without spending extra time and money on securing a certificate for all of our EC2 instances, with potentially many on the way. We circumvented this issue by adding a load balancer to intercept all requests. The load balancer then “shares” one certificate with all the EC2 instances, allowing secure connections to be made with our potentially many EC2 instances.
                    </li>
                  </ul>
                  </li>
                  <li class="list-group-item">CORS permissions
                  <ul>
                    <li>
                    As it turns out, web requests have certain special settings that must be set to allow the programmatic usage of API responses. This was fixed by adding a post-processing function for all responses in the Flask app itself. It adds certain properties to the response that allows for it to be used in other programs.
                    </li>
                  </ul>
                  </li>
                  <li class="list-group-item">SQL Alchemy
                  <ul>
                    <li>
                    SQL Alchemy is extremely structured, meaning that it has a high learning curve for developers learning it for the first time. In particular, while implementing the backend call for getting all of a particular data model, getting just one by using SQL Alchemy was difficult. We circumvent this by implementing single calls by post-processing calls to get all of a particular data model.
                    </li>
                  </ul>
                  </li>
                  <li class="list-group-item">Non-robust API
                  <ul>
                    <li>
                    We ran into issues in development where the API was being overloaded by somewhat reasonable requests coming in. This was because the development flask server only has one process listening to the specified port. We solved this issue by running a Gunicorn server on top of the Flask app.
                    </li>
                  </ul>
                  </li>
              </ul>
              <h2 className="text-center p-3">
                Tools Used
              </h2>
              <ToolList />
              <div class="row">
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}