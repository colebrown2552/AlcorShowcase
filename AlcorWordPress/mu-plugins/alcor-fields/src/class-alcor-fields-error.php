<?php
/**
 * AlcorFields validation error.
 *
 * One exception type carries every problem found in a template, a submitted value or an import file, each with the
 * path of the field it belongs to. The editor screen and the REST API both turn the list into messages, so an editor
 * sees all problems at once instead of fixing them one save at a time.
 *
 * @package AlcorWordPress
 */

if ( ! defined( 'ABSPATH' ) && ! defined( 'ALCOR_FIELDS_CLI' ) ) {
	exit;
}

/**
 * A template, a value or an import file was refused.
 */
final class Alcor_Fields_Error extends InvalidArgumentException {

	/**
	 * Every problem, in the order found.
	 *
	 * @var array<int, array{path: string, message: string}>
	 */
	public $errors = array();

	/**
	 * Builds an error for a single problem.
	 *
	 * @param string $path    Where the problem is: a field path such as "work.items[2].title", or a template line.
	 * @param string $message What is wrong, in words an editor can act on.
	 * @return self
	 */
	public static function at( $path, $message ) {
		$error         = new self( $path . ': ' . $message );
		$error->errors = array(
			array(
				'path'    => (string) $path,
				'message' => (string) $message,
			),
		);
		return $error;
	}

	/**
	 * Builds an error for a list of problems.
	 *
	 * @param array<int, array{path: string, message: string}> $errors Every problem found.
	 * @return self
	 */
	public static function many( array $errors ) {
		$first         = $errors ? $errors[0]['path'] . ': ' . $errors[0]['message'] : 'invalid';
		$error         = new self( count( $errors ) > 1 ? $first . ' (and ' . ( count( $errors ) - 1 ) . ' more)' : $first );
		$error->errors = $errors;
		return $error;
	}
}
