import { collegeEmailProblem, describeValidationError } from './form-checks';

describe('collegeEmailProblem', () => {
  it('passes a college address beside a personal one', () => {
    expect(collegeEmailProblem('1mp25mdm01@bgscet.ac.in', 'asha@gmail.com')).toBeNull();
  });

  it('refuses the same address in both boxes, whatever the case', () => {
    expect(collegeEmailProblem('Asha@Gmail.com ', 'asha@gmail.com')).toContain('are the same');
  });

  it('refuses a public mail address in the college box', () => {
    expect(collegeEmailProblem('asha@gmail.com', 'asha.rao@yahoo.com')).toContain('personal address');
  });

  it('leaves an address on an unlisted college domain to the office', () => {
    expect(collegeEmailProblem('asha@some-college.edu.in', 'asha@gmail.com')).toBeNull();
  });
});

describe('describeValidationError', () => {
  it("names the form's box and drops pydantic's prefix", () => {
    const detail = [
      {
        loc: ['body', 'body', 'linkedin_url'],
        msg: 'Value error, enter your LinkedIn profile link, e.g. linkedin.com/in/your-name',
      },
    ];
    expect(describeValidationError(detail)).toBe(
      'LinkedIn profile: enter your LinkedIn profile link, e.g. linkedin.com/in/your-name',
    );
  });

  it('lists every refused field once', () => {
    const detail = [
      { loc: ['body', 'phone'], msg: 'Field required' },
      { loc: ['body', 'photo'], msg: 'Field required' },
      { loc: ['body', 'phone'], msg: 'Field required' },
    ];
    expect(describeValidationError(detail)).toBe('Phone: Field required Photo: Field required');
  });

  it('is null for a string detail or nothing', () => {
    expect(describeValidationError('A valid email is required.')).toBeNull();
    expect(describeValidationError(undefined)).toBeNull();
    expect(describeValidationError([])).toBeNull();
  });
});
