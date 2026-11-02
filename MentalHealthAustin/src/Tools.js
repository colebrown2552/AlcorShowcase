// Grid of the tools and frameworks used to build the site (shown on the About page).
import React from 'react';

/**
 * Renders a card per tool with its logo and link.
 * @returns {JSX.Element} the tool list.
 */
const ToolList = () => {
  const tools = [
    {
      name: 'React',
      imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/a/a7/React-icon.svg',
      homepageUrl: 'https://reactjs.org/',
    },
    {
      name: 'AWS Amplify',
      imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/9/93/Amazon_Web_Services_Logo.svg',
      homepageUrl: 'https://aws.amazon.com/amplify/',
    },
    {
      name: 'Bootstrap',
      imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/b/b2/Bootstrap_logo.svg',
      homepageUrl: 'https://getbootstrap.com/',
    },
    {
      name: 'Visual Studio Code',
      imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/9/9a/Visual_Studio_Code_1.35_icon.svg',
      homepageUrl: 'https://code.visualstudio.com/',
    },
    {
      name: 'GitLab',
      imageUrl: 'https://upload.wikimedia.org/wikipedia/commons/e/e1/GitLab_logo.svg',
      homepageUrl: 'https://about.gitlab.com/',
    },
  ];

  return (
    <div className="container">
    <div className="row p-3">
        {tools.map((tool, index) => (
        <div className="col-md-4 text-center" key={index}>
            <div className="p-3">
                <img src={tool.imageUrl} className="" alt={`${tool.name} Logo`} width="100" height="100" />
                <div className="">
                    <a href={tool.homepageUrl}>{tool.name}</a>
                </div>
            </div>
        </div>
        ))}
    </div>
    </div>

  );
};

export default ToolList;
