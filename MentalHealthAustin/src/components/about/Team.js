// Initials avatar for a team member card (no photos are included in this repository).
import React from 'react';

/**
 * Circular avatar showing a member's initials.
 * @param {{name: string}} props the member's full name.
 * @returns {JSX.Element} the avatar.
 */
function Team({ name }) {
  const initials = name.split(' ').map((part) => part.charAt(0)).join('').toUpperCase();

  return (
    <div className='team-container d-flex justify-content-center my-3'>
      <div
        className='d-flex align-items-center justify-content-center rounded-circle bg-primary text-white'
        style={{ width: 96, height: 96, fontSize: 36, fontWeight: 600 }}
        aria-hidden="true"
      >
        {initials}
      </div>
    </div>
  );
}


export default Team;