// Team cards for the About page: each member's role, commit count and unit-test count.
// Counts are a static snapshot (src/data/teamStats.json) taken from the project's version history,
// so the page needs no network access or credentials.
import React from 'react';
import Team from './Team';
import teamStats from '../../data/teamStats.json';

/**
 * Renders one card per team member from the static team statistics.
 * @returns {JSX.Element} a grid of member cards.
 */
const GitLabStats = () => {
  return (
    <div className="container mt-5 bios">
      <div className="row">
        {teamStats.map((member) => (
          <div key={member.name} className="col-md-4 mb-4">
            <div className="card">
              <div className="card-body">
                <h5 className="card-text dark-blue">{member.name}</h5>
                <Team name={member.name} />
                <p className="card-text">Commits: {member.commits}</p>
                <p className="card-text">Role: {member.role}</p>
                <p className="card-text">Unit Tests: {member.tests}</p>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default GitLabStats;